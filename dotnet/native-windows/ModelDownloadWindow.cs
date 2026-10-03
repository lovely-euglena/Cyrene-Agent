using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using CyreneNative.ModelDownload;

namespace CyreneNative;

/// <summary>
/// 「模型下载」独立窗口（kind="model-download"）：
///   - 两个模型卡片：BGE-M3（本地检索必装）/ bge-reranker-base（重排，可选），
///     显示安装状态 + 一键下载（已装时按钮变「重新下载」）；
///   - 下载执行在 ModelDownloader（官方源 / hf-mirror、Range 断点续传、进度、取消）；
///     本窗只做视图与调度，模型目录与初始镜像由宿主 spawn 时经 layout 传入；
///   - 镜像源切换即写 general settings（ragDownloadMirror，与设置页同键）；
///   - 完成后自动刷新本窗状态，并请求宿主重推设置快照（设置页状态同步）。
/// 入口：设置页（React / WPF）「下载模型」按钮 → 宿主 spawn 本窗。
/// </summary>
public sealed class ModelDownloadWindow : NativeWindow
{
    private Window? _window;
    private readonly ModelDownloader _downloader = new();
    private readonly string _modelsDir;
    private string _mirror;
    private CancellationTokenSource? _cts;
    private bool _busy;
    private int? _lastPercent;

    private readonly TextBlock _bgem3Status = MakeStatus();
    private readonly TextBlock _rerankerStatus = MakeStatus();
    private readonly TextBlock _stageText = new()
    {
        FontSize = 12,
        Foreground = NativeTheme.TextMutedBrush,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 6, 0, 0),
    };
    private readonly Border _progressTrack = new()
    {
        Height = 8,
        CornerRadius = new CornerRadius(4),
        Background = NativeTheme.BorderSoftBrush,
        ClipToBounds = true,
    };
    private readonly Border _progressFill = new()
    {
        Height = 8,
        CornerRadius = new CornerRadius(4),
        Background = NativeTheme.PinkBrush,
        HorizontalAlignment = HorizontalAlignment.Left,
        Width = 0,
    };
    private readonly Button _bgem3Button = new();
    private readonly Button _rerankerButton = new();
    private readonly Button _cancelButton = new()
    {
        Content = "取消下载",
        MinWidth = 96,
        Visibility = Visibility.Collapsed,
        Style = NativeTheme.SecondaryButtonStyle,
    };
    private readonly ComboBox _mirrorBox = new()
    {
        Width = 150,
        Style = NativeTheme.ComboBoxStyle,
        VerticalAlignment = VerticalAlignment.Center,
    };

    public override string Kind => "model-download";
    public override bool IsClosed => _window is null;

    public ModelDownloadWindow(JsonElement layout)
    {
        _modelsDir = ReadString(layout, "modelsDir") ?? "";
        _mirror = ReadString(layout, "mirror") == "hf-mirror" ? "hf-mirror" : "official";

        _window = new Window
        {
            Title = "昔涟 · 模型下载",
            Width = 620,
            Height = 480,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            ShowInTaskbar = true,
            Icon = AppIcons.Image,
        };
        NativeTheme.Apply(_window);

        var root = new StackPanel { Margin = new Thickness(20, 12, 20, 16) };
        root.Children.Add(new TextBlock
        {
            Text = "把本地检索模型下载到模型目录（支持断点续传，下载中可取消）。",
            FontSize = 13,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
        });
        root.Children.Add(new TextBlock
        {
            Text = _modelsDir.Length > 0 ? $"目标目录：{_modelsDir}" : "未收到模型目录：请从设置页重新打开本窗口。",
            FontSize = 12,
            Foreground = NativeTheme.TextMutedBrush,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(0, 4, 0, 0),
            ToolTip = _modelsDir,
        });

        ConfigureDownloadButton(_bgem3Button, ModelDownloadSpecs.BgeM3);
        ConfigureDownloadButton(_rerankerButton, ModelDownloadSpecs.Reranker);
        root.Children.Add(BuildCard(
            "BGE-M3（必装）",
            "本地检索主模型，约 570MB。文件落在 models/Xenova/bge-m3/。",
            _bgem3Status,
            _bgem3Button));
        root.Children.Add(BuildCard(
            "bge-reranker-base（可选）",
            "检索结果重排序，约 279MB；不安装则检索不做重排。",
            _rerankerStatus,
            _rerankerButton));

        // 镜像源
        var mirrorRow = new Grid { Margin = new Thickness(0, 14, 0, 0) };
        mirrorRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        mirrorRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        mirrorRow.Children.Add(new TextBlock
        {
            Text = "下载镜像源",
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
            VerticalAlignment = VerticalAlignment.Center,
        });
        _mirrorBox.Items.Add(new ComboBoxItem { Content = "官方源", Style = NativeTheme.ComboBoxItemStyle });
        _mirrorBox.Items.Add(new ComboBoxItem { Content = "hf-mirror", Style = NativeTheme.ComboBoxItemStyle });
        _mirrorBox.SelectedIndex = _mirror == "hf-mirror" ? 1 : 0;
        _mirrorBox.SelectionChanged += (_, _) =>
        {
            var value = _mirrorBox.SelectedIndex == 1 ? "hf-mirror" : "official";
            if (value == _mirror) return;
            _mirror = value;
            // 与设置页同键：写 general settings（下次打开沿用）
            RequestRouter.SendSetting("ragDownloadMirror", value);
        };
        Grid.SetColumn(_mirrorBox, 1);
        mirrorRow.Children.Add(_mirrorBox);
        root.Children.Add(mirrorRow);

        // 进度区
        var progressPanel = new StackPanel { Margin = new Thickness(0, 14, 0, 0) };
        var trackGrid = new Grid();
        trackGrid.Children.Add(_progressFill);
        _progressTrack.Child = trackGrid;
        _progressTrack.SizeChanged += (_, _) => UpdateProgressWidth();
        progressPanel.Children.Add(_progressTrack);
        progressPanel.Children.Add(_stageText);
        root.Children.Add(progressPanel);

        // 底部操作
        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 16, 0, 0),
        };
        var openDir = new Button
        {
            Content = "打开模型目录",
            MinWidth = 110,
            Margin = new Thickness(0, 0, 8, 0),
            Style = NativeTheme.SecondaryButtonStyle,
        };
        openDir.Click += (_, _) => RequestRouter.SendSettingsAction("cyrene", "open-model-dir");
        actions.Children.Add(openDir);
        _cancelButton.Click += (_, _) => Cancel();
        actions.Children.Add(_cancelButton);
        root.Children.Add(actions);

        NativeTheme.ApplyDialogShell(_window, "模型下载", root, 12);

        _window.Closed += (_, _) =>
        {
            try { _cts?.Cancel(); } catch { /* 已结束 */ }
            _downloader.Dispose();
            _window = null;
            RaiseClosed();
        };

        RefreshStatuses();
    }

    // ── 视图助手 ──

    private static TextBlock MakeStatus() => new()
    {
        FontSize = 13,
        Foreground = NativeTheme.TextMutedBrush,
        Margin = new Thickness(0, 6, 0, 0),
        TextWrapping = TextWrapping.Wrap,
    };

    private static Border BuildCard(string title, string description, TextBlock status, Button action)
    {
        var info = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        info.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = NativeTheme.TextStrongBrush,
        });
        info.Children.Add(new TextBlock
        {
            Text = description,
            FontSize = 13,
            Foreground = NativeTheme.TextMutedBrush,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 2, 0, 0),
        });
        info.Children.Add(status);

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(info);
        Grid.SetColumn(action, 1);
        action.VerticalAlignment = VerticalAlignment.Center;
        grid.Children.Add(action);

        return new Border
        {
            Background = Brushes.White,
            BorderBrush = NativeTheme.BorderSoftBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(14, 12, 14, 12),
            Margin = new Thickness(0, 8, 0, 0),
            Child = grid,
        };
    }

    private void ConfigureDownloadButton(Button button, ModelSpec spec)
    {
        button.MinWidth = 96;
        button.Style = NativeTheme.PrimaryButtonStyle;
        button.Click += (_, _) => StartDownload(spec);
    }

    private static string? ReadString(JsonElement layout, string name)
    {
        if (layout.ValueKind != JsonValueKind.Object) return null;
        return layout.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;
    }

    private static string DisplayName(ModelSpec spec) => spec.Kind == "reranker" ? "bge-reranker-base" : "BGE-M3";

    private static string FormatBytes(long bytes)
    {
        if (bytes >= 1024L * 1024 * 1024) return $"{bytes / 1024.0 / 1024 / 1024:F2} GB";
        if (bytes >= 1024L * 1024) return $"{bytes / 1024.0 / 1024:F1} MB";
        if (bytes >= 1024) return $"{bytes / 1024.0:F0} KB";
        return $"{bytes} B";
    }

    // ── 状态与进度 ──

    private void RefreshStatuses()
    {
        var bgem3 = ModelDownloader.IsInstalled(_modelsDir, ModelDownloadSpecs.BgeM3);
        var reranker = ModelDownloader.IsInstalled(_modelsDir, ModelDownloadSpecs.Reranker);
        _bgem3Status.Text = bgem3 ? "已安装" : "未安装";
        _bgem3Status.Foreground = bgem3 ? NativeTheme.PinkDarkBrush : NativeTheme.TextMutedBrush;
        _rerankerStatus.Text = reranker ? "已安装" : "未安装（可选）";
        _rerankerStatus.Foreground = reranker ? NativeTheme.PinkDarkBrush : NativeTheme.TextMutedBrush;
        _bgem3Button.Content = bgem3 ? "重新下载" : "下载";
        _rerankerButton.Content = reranker ? "重新下载" : "下载";
    }

    private void SetProgress(int? percent)
    {
        _lastPercent = percent;
        UpdateProgressWidth();
    }

    private void UpdateProgressWidth()
    {
        var width = _progressTrack.ActualWidth;
        _progressFill.Width = _lastPercent is { } percent
            ? Math.Max(0, Math.Min(100, percent)) / 100.0 * width
            : 0;
    }

    private void ApplyProgress(ModelDownloadProgress progress)
    {
        switch (progress.Phase)
        {
            case ModelDownloadPhase.Planning:
                SetProgress(null);
                _stageText.Text = "正在检查本地文件…";
                return;
            case ModelDownloadPhase.Done:
                SetProgress(100);
                _stageText.Text = "下载完成";
                return;
            default:
                SetProgress(progress.Percent);
                var received = FormatBytes(progress.ReceivedBytes);
                var total = progress.TotalBytes is { } totalBytes ? FormatBytes(totalBytes) : "?";
                var percentText = progress.Percent is { } value ? $"{value}%" : "--";
                _stageText.Text = $"正在下载 {progress.File} · {percentText}（{received} / {total}）· {progress.CompletedFiles}/{progress.TotalFiles} 个文件";
                return;
        }
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        _bgem3Button.IsEnabled = !busy;
        _rerankerButton.IsEnabled = !busy;
        _cancelButton.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
    }

    private void Cancel()
    {
        try { _cts?.Cancel(); } catch { /* 已结束 */ }
        _stageText.Text = "正在取消…";
    }

    // ── 下载调度 ──

    private void StartDownload(ModelSpec spec)
    {
        if (_busy) return;
        if (string.IsNullOrEmpty(_modelsDir))
        {
            _stageText.Text = "未收到模型目录，无法下载；请从设置页重新打开本窗口。";
            return;
        }

        var display = DisplayName(spec);
        var mirror = _mirror;
        _cts = new CancellationTokenSource();
        var token = _cts.Token;
        SetBusy(true);
        SetProgress(0);
        _stageText.Text = $"准备下载 {display}…";

        _ = Task.Run(async () =>
        {
            try
            {
                await _downloader.DownloadAsync(
                    spec,
                    _modelsDir,
                    mirror,
                    progress => _window?.Dispatcher.InvokeAsync(() => ApplyProgress(progress)),
                    token);
                _window?.Dispatcher.InvokeAsync(() =>
                {
                    SetBusy(false);
                    RefreshStatuses();
                    _stageText.Text = $"{display} 下载完成。";
                    // 设置页状态同步：请求宿主重推设置快照（设置窗打开时即时可见）
                    RequestRouter.SendSettingsAction("cyrene", "check-model-update");
                });
            }
            catch (OperationCanceledException)
            {
                _window?.Dispatcher.InvokeAsync(() =>
                {
                    SetBusy(false);
                    _stageText.Text = "已取消（已下载部分保留，重新下载可续传）。";
                });
            }
            catch (Exception ex)
            {
                _window?.Dispatcher.InvokeAsync(() =>
                {
                    SetBusy(false);
                    _stageText.Text = $"下载失败：{ex.Message}";
                });
            }
        });
    }

    // ── NativeWindow ──

    public override void ShowWindow() => _window?.Show();
    public override void Activate() => _window?.Activate();
    public override void Close() => _window?.Close();
    public override void ApplyLayout(JsonElement layout)
    {
        // 下载窗不参与布局联动
    }
}
