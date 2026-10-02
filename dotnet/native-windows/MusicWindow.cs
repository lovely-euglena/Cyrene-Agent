using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using CyreneNative.Music;

namespace CyreneNative;

/// <summary>
/// 本地音乐播放器窗口（kind="music"）：
///   - 左：搜索/文件夹过滤 + 曲目列表（双击播放）；
///   - 右：歌词面板（侧车 .lrc，当前行高亮 + 点击跳转 + 自动滚动）；
///   - 底：上一首/播放暂停/下一首/模式 + 进度 + 音量 + Agent 权限下拉；
///   - 顶：扫描/添加/移除文件夹。
/// 播放与曲库由进程内 MusicService 持有（关窗后 Agent 仍可控制），
/// 窗口只做视图与直连调用；文件夹与 Agent 权限变更经 cmd 事件交宿主持久化。
/// </summary>
public sealed class MusicWindow : NativeWindow
{
    private Window? _window;
    private readonly MusicService _service = MusicService.Shared;

    private readonly ListBox _trackList = new();
    private readonly TextBox _searchBox = new();
    private readonly ComboBox _folderBox = new();
    private readonly ComboBox _accessBox = new();
    private readonly TextBlock _statusText = new() { FontSize = 12, Foreground = NativeTheme.TextMutedBrush, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _nowTitle = new() { FontSize = 18, FontWeight = FontWeights.SemiBold, Foreground = NativeTheme.TextStrongBrush };
    private readonly TextBlock _nowArtist = new() { FontSize = 12, Foreground = NativeTheme.TextMutedBrush, Margin = new Thickness(0, 2, 0, 0) };
    private readonly TextBlock _positionText = new() { FontSize = 12, Foreground = NativeTheme.TextMutedBrush, Width = 44, TextAlignment = TextAlignment.Right };
    private readonly TextBlock _durationText = new() { FontSize = 12, Foreground = NativeTheme.TextMutedBrush, Width = 44 };
    private readonly Slider _progress = new() { Minimum = 0, Maximum = 100, IsMoveToPointEnabled = true, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 8, 0) };
    private readonly Slider _volume = new() { Minimum = 0, Maximum = 100, Width = 120, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(6, 0, 0, 0) };
    private readonly TextBlock _playGlyph = Md("\uE768", 18, NativeTheme.TextStrongBrush);
    private readonly TextBlock _modeLabel = new() { FontSize = 12, Foreground = NativeTheme.TextDefaultBrush, VerticalAlignment = VerticalAlignment.Center };
    private readonly StackPanel _lyricsStack = new() { Margin = new Thickness(12, 8, 12, 8) };
    private readonly ScrollViewer _lyricsScroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
    private readonly List<TextBlock> _lyricBlocks = new();
    private readonly List<LrcParser.LrcLine> _lyricLines = new();
    private readonly DispatcherTimer _searchDebounce = new() { Interval = TimeSpan.FromMilliseconds(300) };

    private LrcParser.LrcDocument? _lyrics;
    private string? _lyricsPath;
    private int _lyricIndex = -1;
    private bool _updatingVolume;
    private bool _rebuildingFolders;
    private List<MusicService.TrackDto> _tracks = new();

    public override string Kind => "music";
    public override bool IsClosed => _window is null;

    public MusicWindow(JsonElement layout)
    {
        _window = new Window
        {
            Title = "昔涟 · 本地音乐",
            Width = 1020,
            Height = 700,
            MinWidth = 820,
            MinHeight = 560,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.CanResize,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = true,
            Icon = AppIcons.Image,
        };
        NativeTheme.Apply(_window);

        var root = new Grid { Margin = new Thickness(20, 10, 20, 16) };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        root.Children.Add(BuildToolbar(layout));
        var content = BuildContent();
        Grid.SetRow(content, 1);
        root.Children.Add(content);
        var controls = BuildControls();
        Grid.SetRow(controls, 2);
        root.Children.Add(controls);

        NativeTheme.ApplyDialogShell(_window, "本地音乐", root, 12);

        _service.StateChanged += OnStateChanged;
        _service.PositionTick += OnPositionTick;
        _service.LibraryChanged += OnLibraryChanged;
        _service.Notice += OnNotice;
        _searchDebounce.Tick += (_, _) =>
        {
            _searchDebounce.Stop();
            RefreshTracks();
        };

        _window.Closed += (_, _) =>
        {
            _service.StateChanged -= OnStateChanged;
            _service.PositionTick -= OnPositionTick;
            _service.LibraryChanged -= OnLibraryChanged;
            _service.Notice -= OnNotice;
            _window = null;
            RaiseClosed();
        };

        RefreshFolders();
        RefreshTracks();
        OnStateChanged();
        if (_service.TotalTracks() == 0 && _service.Folders.Count > 0) _service.Rescan();
    }

    private static TextBlock Md(string glyph, double size, Brush brush) => new()
    {
        Text = glyph,
        FontFamily = new FontFamily("Segoe MDL2 Assets"),
        FontSize = size,
        Foreground = brush,
        VerticalAlignment = VerticalAlignment.Center,
        HorizontalAlignment = HorizontalAlignment.Center,
    };

    private static Border Card(FrameworkElement child, Thickness? padding = null) => new()
    {
        Background = Brushes.White,
        BorderBrush = NativeTheme.BorderSoftBrush,
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(10),
        Padding = padding ?? new Thickness(8),
        Child = child,
    };

    // ── 工具栏 ──

    private FrameworkElement BuildToolbar(JsonElement layout)
    {
        var panel = new WrapPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 8) };

        _searchBox.Width = 200;
        _searchBox.Height = 30;
        _searchBox.ToolTip = "搜索标题 / 歌手 / 专辑";
        _searchBox.VerticalContentAlignment = VerticalAlignment.Center;
        _searchBox.TextChanged += (_, _) =>
        {
            _searchDebounce.Stop();
            _searchDebounce.Start();
        };
        panel.Children.Add(new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(8, 0, 8, 0),
            Margin = new Thickness(0, 0, 8, 0),
            Child = _searchBox,
        });

        _folderBox.Width = 190;
        _folderBox.Height = 30;
        _folderBox.Margin = new Thickness(0, 0, 8, 0);
        _folderBox.SelectionChanged += (_, _) =>
        {
            if (!_rebuildingFolders) RefreshTracks();
        };
        panel.Children.Add(_folderBox);

        panel.Children.Add(ToolButton("\uE72C", "重新扫描", () =>
        {
            _service.Rescan();
            _statusText.Text = "扫描中…";
        }));
        panel.Children.Add(ToolButton("\uE710", "添加音乐文件夹", AddFolder));
        panel.Children.Add(ToolButton("\uE738", "移除选中的音乐文件夹", RemoveFolder));

        panel.Children.Add(new TextBlock { Text = "Agent 权限", FontSize = 12, Foreground = NativeTheme.TextMutedBrush, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(16, 0, 6, 0) });
        foreach (var (tag, label) in new[] { ("off", "关闭"), ("read", "只读"), ("control", "控制播放"), ("manage", "管理曲库") })
        {
            _accessBox.Items.Add(new ComboBoxItem { Content = label, Tag = tag });
        }
        _accessBox.Width = 110;
        _accessBox.Height = 30;
        _accessBox.ToolTip = "允许昔涟读取/操作本地音乐（保存到宿主设置）";
        _accessBox.SelectionChanged += (_, _) =>
        {
            if (_accessBox.SelectedItem is ComboBoxItem { Tag: string value })
            {
                RequestRouter.SendCommand("music", "agent-access-changed", null, new Dictionary<string, object?> { ["access"] = value });
            }
        };
        panel.Children.Add(_accessBox);

        // 初始权限（宿主 spawn 时随 layout 传入；缺省 read）
        var initialAccess = layout.ValueKind == JsonValueKind.Object && layout.TryGetProperty("agentAccess", out var accessEl) && accessEl.ValueKind == JsonValueKind.String
            ? accessEl.GetString() ?? "read"
            : "read";
        foreach (ComboBoxItem item in _accessBox.Items)
        {
            if ((item.Tag as string) == initialAccess)
            {
                _accessBox.SelectedItem = item;
                break;
            }
        }

        return panel;
    }

    private Button ToolButton(string glyph, string tip, Action onClick)
    {
        var button = NativeTheme.MakeCircleButton(Md(glyph, 14, NativeTheme.TextDefaultBrush), 30, tip, onClick);
        button.Margin = new Thickness(0, 0, 6, 0);
        return button;
    }

    // ── 内容区（列表 + 歌词） ──

    private FrameworkElement BuildContent()
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star) });

        _trackList.BorderThickness = new Thickness(0);
        _trackList.Background = Brushes.Transparent;
        _trackList.FontSize = 14;
        _trackList.MouseDoubleClick += (_, _) => PlaySelected();
        _trackList.KeyDown += (_, eventArgs) =>
        {
            if (eventArgs.Key == Key.Enter) PlaySelected();
        };
        var listCard = Card(_trackList);
        listCard.Margin = new Thickness(0, 0, 8, 0);
        Grid.SetColumn(listCard, 0);
        grid.Children.Add(listCard);

        _lyricsScroll.Content = _lyricsStack;
        var lyricsCard = Card(_lyricsScroll, new Thickness(0));
        Grid.SetColumn(lyricsCard, 1);
        grid.Children.Add(lyricsCard);
        return grid;
    }

    private void PlaySelected()
    {
        var index = _trackList.SelectedIndex;
        if (index < 0 || index >= _tracks.Count) return;
        _service.PlayTrack(_tracks[index].Path);
    }

    // ── 底部控制条 ──

    private FrameworkElement BuildControls()
    {
        var panel = new Grid { Margin = new Thickness(0, 8, 0, 0) };
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var nowPanel = new Grid();
        nowPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        nowPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var nowText = new StackPanel();
        nowText.Children.Add(_nowTitle);
        nowText.Children.Add(_nowArtist);
        Grid.SetColumn(nowText, 0);
        nowPanel.Children.Add(nowText);
        Grid.SetColumn(_statusText, 1);
        nowPanel.Children.Add(_statusText);
        panel.Children.Add(nowPanel);

        var row = new Grid { Margin = new Thickness(0, 6, 0, 0) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var prevButton = NativeTheme.MakeCircleButton(Md("\uE892", 15, NativeTheme.TextDefaultBrush), 34, "上一首", () => _service.PrevTrack());
        var playButton = NativeTheme.MakeCircleButton(_playGlyph, 40, "播放/暂停", () => _service.Toggle());
        playButton.Background = NativeTheme.PinkSoftBrush;
        var nextButton = NativeTheme.MakeCircleButton(Md("\uE893", 15, NativeTheme.TextDefaultBrush), 34, "下一首", () => _service.NextTrack());
        var modeButton = NativeTheme.MakeCircleButton(_modeLabel, 38, "播放模式", CycleMode);
        Grid.SetColumn(prevButton, 0);
        Grid.SetColumn(playButton, 1);
        Grid.SetColumn(nextButton, 2);
        Grid.SetColumn(modeButton, 3);
        row.Children.Add(prevButton);
        row.Children.Add(playButton);
        row.Children.Add(nextButton);
        row.Children.Add(modeButton);

        var progressPanel = new Grid();
        progressPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        progressPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        progressPanel.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(_positionText, 0);
        Grid.SetColumn(_progress, 1);
        Grid.SetColumn(_durationText, 2);
        progressPanel.Children.Add(_positionText);
        progressPanel.Children.Add(_progress);
        progressPanel.Children.Add(_durationText);
        Grid.SetColumn(progressPanel, 4);
        row.Children.Add(progressPanel);

        _progress.PreviewMouseLeftButtonUp += (_, _) => _service.SeekSeconds(_progress.Value);
        _volume.ValueChanged += (_, eventArgs) =>
        {
            if (!_updatingVolume) _service.SetVolumeLevel((int)Math.Round(eventArgs.NewValue));
        };

        var volumePanel = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        volumePanel.Children.Add(Md("\uE767", 14, NativeTheme.TextMutedBrush));
        volumePanel.Children.Add(_volume);
        Grid.SetColumn(volumePanel, 5);
        row.Children.Add(volumePanel);

        var settingsButton = NativeTheme.MakeCircleButton(Md("\uE713", 15, NativeTheme.TextMutedBrush), 32, "打开宿主设置", () => RequestRouter.SendCommand("music", "open-settings"));
        settingsButton.Margin = new Thickness(8, 0, 0, 0);
        Grid.SetColumn(settingsButton, 6);
        row.Children.Add(settingsButton);

        Grid.SetRow(row, 1);
        panel.Children.Add(row);
        return panel;
    }

    private void CycleMode()
    {
        var current = _service.NowPlaying().Mode;
        var next = current switch
        {
            "list" => "single",
            "single" => "shuffle",
            _ => "list",
        };
        _service.SetMode(next);
    }

    // ── 数据刷新 ──

    private void RefreshFolders()
    {
        _rebuildingFolders = true;
        try
        {
            _folderBox.Items.Clear();
            _folderBox.Items.Add(new ComboBoxItem { Content = "全部文件夹", Tag = "" });
            foreach (var entry in _service.FolderEntries())
            {
                _folderBox.Items.Add(new ComboBoxItem
                {
                    Content = $"{Path.GetFileName(entry.Path)}（{entry.TrackCount}）",
                    Tag = entry.Path,
                    ToolTip = entry.Path,
                });
            }
            _folderBox.SelectedIndex = 0;
        }
        finally
        {
            _rebuildingFolders = false;
        }
    }

    private void RefreshTracks()
    {
        var search = _searchBox.Text.Trim();
        var folder = (_folderBox.SelectedItem as ComboBoxItem)?.Tag as string ?? "";
        _tracks = _service.SearchTracks(search, folder);
        _trackList.ItemsSource = _tracks
            .Select(track => string.IsNullOrEmpty(track.Artist) ? track.Title : $"{track.Title} — {track.Artist}")
            .ToList();
        _statusText.Text = $"{_tracks.Count} / {_service.TotalTracks()} 首{(_service.IsScanning ? " · 扫描中…" : "")}";
    }

    private void AddFolder()
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "选择音乐文件夹", Multiselect = true };
        if (dialog.ShowDialog(_window) != true) return;
        foreach (var folder in dialog.FolderNames)
        {
            _service.AddFolder(folder);
        }
    }

    private void RemoveFolder()
    {
        var folder = (_folderBox.SelectedItem as ComboBoxItem)?.Tag as string;
        if (string.IsNullOrEmpty(folder))
        {
            _statusText.Text = "先在左侧下拉中选择要移除的文件夹";
            return;
        }
        _service.RemoveFolder(folder);
    }

    // ── MusicService 事件（IPC/扫描线程 → UI 线程） ──

    private void OnStateChanged()
    {
        _window?.Dispatcher.BeginInvoke(() =>
        {
            var nowPlaying = _service.NowPlaying();
            _nowTitle.Text = nowPlaying.Title.Length > 0 ? nowPlaying.Title : "未播放";
            _nowArtist.Text = string.IsNullOrEmpty(nowPlaying.Artist)
                ? nowPlaying.Album
                : nowPlaying.Album.Length > 0 ? $"{nowPlaying.Artist} · {nowPlaying.Album}" : nowPlaying.Artist;
            _playGlyph.Text = nowPlaying.Paused ? "\uE768" : "\uE769";
            _modeLabel.Text = nowPlaying.Mode switch
            {
                "single" => "单曲",
                "shuffle" => "随机",
                _ => "列表",
            };
            if (nowPlaying.Path != _lyricsPath) RebuildLyrics(nowPlaying.Path);
            _updatingVolume = true;
            _volume.Value = nowPlaying.Volume;
            _updatingVolume = false;
            UpdateProgress(nowPlaying.PositionSec, nowPlaying.DurationSec);
        });
    }

    private void OnPositionTick(double seconds)
    {
        _window?.Dispatcher.BeginInvoke(() =>
        {
            var nowPlaying = _service.NowPlaying();
            UpdateProgress(seconds, nowPlaying.DurationSec);
            UpdateLyricLine();
        });
    }

    private void OnLibraryChanged()
    {
        _window?.Dispatcher.BeginInvoke(() =>
        {
            RefreshFolders();
            RefreshTracks();
        });
    }

    private void OnNotice(string message)
    {
        _window?.Dispatcher.BeginInvoke(() => _statusText.Text = message);
    }

    private void UpdateProgress(double positionSec, double durationSec)
    {
        _progress.Maximum = Math.Max(1, durationSec);
        _progress.Value = Math.Min(Math.Max(0, positionSec), _progress.Maximum);
        _positionText.Text = FormatTime(positionSec);
        _durationText.Text = FormatTime(durationSec);
    }

    private static string FormatTime(double seconds)
    {
        if (seconds <= 0 || double.IsNaN(seconds)) return "00:00";
        var total = (int)Math.Round(seconds);
        return $"{total / 60:00}:{total % 60:00}";
    }

    // ── 歌词 ──

    private void RebuildLyrics(string? path)
    {
        _lyrics = string.IsNullOrEmpty(path) ? null : LrcParser.ParseSidecar(path);
        _lyricsPath = path;
        _lyricBlocks.Clear();
        _lyricLines.Clear();
        _lyricsStack.Children.Clear();
        _lyricIndex = -1;
        if (_lyrics is null || _lyrics.Lines.Count == 0)
        {
            _lyricsStack.Children.Add(new TextBlock
            {
                Text = "暂无歌词（支持同名 .lrc 侧车文件）",
                FontSize = 12,
                Foreground = NativeTheme.TextMutedBrush,
                Margin = new Thickness(0, 24, 0, 0),
                HorizontalAlignment = HorizontalAlignment.Center,
            });
            return;
        }
        foreach (var line in _lyrics.Lines)
        {
            var block = new TextBlock
            {
                Text = line.Text.Length > 0 ? line.Text : "♪",
                FontSize = 14,
                LineHeight = 22,
                TextWrapping = TextWrapping.Wrap,
                Foreground = NativeTheme.TextMutedBrush,
                Margin = new Thickness(0, 3, 0, 3),
                Cursor = Cursors.Hand,
            };
            var captured = line;
            block.MouseLeftButtonUp += (_, _) => _service.SeekSeconds(captured.TimeMs / 1000.0 + (_lyrics?.OffsetMs ?? 0) / 1000.0);
            _lyricBlocks.Add(block);
            _lyricLines.Add(line);
            _lyricsStack.Children.Add(block);
            if (line.Translation is { Length: > 0 })
            {
                _lyricsStack.Children.Add(new TextBlock
                {
                    Text = line.Translation,
                    FontSize = 12,
                    LineHeight = 18,
                    TextWrapping = TextWrapping.Wrap,
                    Foreground = NativeTheme.TextMutedBrush,
                    Opacity = 0.85,
                    Margin = new Thickness(0, 0, 0, 4),
                });
            }
        }
    }

    private void UpdateLyricLine()
    {
        if (_lyrics is null || _lyricBlocks.Count == 0) return;
        var nowPlaying = _service.NowPlaying();
        var index = LrcParser.FindLineIndex(_lyricLines, _lyrics.OffsetMs, (long)(nowPlaying.PositionSec * 1000));
        if (index == _lyricIndex) return;
        if (_lyricIndex >= 0 && _lyricIndex < _lyricBlocks.Count)
        {
            _lyricBlocks[_lyricIndex].Foreground = NativeTheme.TextMutedBrush;
            _lyricBlocks[_lyricIndex].FontWeight = FontWeights.Normal;
        }
        _lyricIndex = index;
        if (index < 0 || index >= _lyricBlocks.Count) return;
        var current = _lyricBlocks[index];
        current.Foreground = NativeTheme.PinkBrush;
        current.FontWeight = FontWeights.SemiBold;
        try
        {
            var top = current.TransformToAncestor(_lyricsStack).Transform(new Point(0, 0)).Y;
            _lyricsScroll.ScrollToVerticalOffset(top - _lyricsScroll.ViewportHeight / 2 + current.ActualHeight / 2);
        }
        catch
        {
            // 布局未完成：下一次 tick 再滚
        }
    }

    // ── NativeWindow ──

    public override void ShowWindow() => _window?.Show();
    public override void Activate() => _window?.Activate();
    public override void Close() => _window?.Close();
    public override void ApplyLayout(JsonElement layout)
    {
        // 音乐窗不参与 pet 布局联动
    }
}
