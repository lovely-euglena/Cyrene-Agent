using System.Text.Json;
using System.Windows.Forms;
using System.Drawing;
using WinFormsButton = System.Windows.Forms.Button;
namespace CyreneNative;

/// <summary>
/// 昔涟·今日日程窗（WinForms——列表 + 7 天柱状图，无动画无 WebGL，
/// 性能要求不高，Form 足够且更省）。
/// 数据：state.tasks 推送（scheduled tasks + token usage）。
/// 动作：openSettings 回发宿主。
/// </summary>
public sealed class TasksWindow : NativeWindow
{
    private readonly Form _form;
    private readonly Label _scheduleCount;
    private readonly Label _scheduleDate;
    private readonly FlowLayoutPanel _taskList;
    private readonly Label _tokenSummary;
    private readonly Panel _chartPanel;
    private readonly TableLayoutPanel _root;

    public override string Kind => "tasks";
    public override bool IsClosed => _form == null;

    public TasksWindow(JsonElement layout)
    {
        _form = new Form
        {
            Text = "昔涟 · 今日日程",
            Icon = AppIcons.FormIcon,
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual,
            Size = new Size(360, 760),
            MinimumSize = new Size(300, 540),
            ShowInTaskbar = false,
            BackColor = System.Drawing.Color.White,
            TopMost = false,
        };

        // pearl-white 字色 token（对齐设置/侧栏浅色壳）
        var textPrimary = System.Drawing.Color.FromArgb(0x1D, 0x1D, 0x1F);
        var textMuted = System.Drawing.Color.FromArgb(0x6F, 0x68, 0x76);
        var accent = System.Drawing.Color.FromArgb(0xFF, 0x5B, 0x8A);

        _root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            BackColor = System.Drawing.Color.Transparent,
            Padding = new Padding(14),
        };
        _root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));   // titlebar
        _root.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));   // 日程概览
        _root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // 任务列表
        _root.RowStyles.Add(new RowStyle(SizeType.Absolute, 150));  // token 图表

        // ── titlebar ──
        var titlebar = new TableLayoutPanel { ColumnCount = 4, Dock = DockStyle.Fill, BackColor = System.Drawing.Color.Transparent };
        titlebar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        titlebar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        titlebar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        titlebar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var title = new Label
        {
            Text = "昔涟 · 今日日程",
            ForeColor = textPrimary,
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Font = new Font("Microsoft YaHei UI", 10.5f),
        };
        titlebar.Controls.Add(title, 0, 0);
        // 设置入口：回发 cmd(kind=tasks, action=openSettings, section=tasks) →
        // 宿主 openSettingsWindow("tasks") 打开 WPF 设置窗定时任务页。
        // 旧实现只有最小化/关闭，启用 native 后任务窗无法进设置。
        var settingsBtn = MakeTitleButton("⚙", () => RequestRouter.SendCommand("tasks", "openSettings", "tasks"));
        settingsBtn.Font = new Font("Segoe UI Symbol", 10f);
        var minBtn = MakeTitleButton("—", () => _form.WindowState = FormWindowState.Minimized);
        var closeBtn = MakeTitleButton("✕", _form.Close);
        titlebar.Controls.Add(settingsBtn, 1, 0);
        titlebar.Controls.Add(minBtn, 2, 0);
        titlebar.Controls.Add(closeBtn, 3, 0);
        // 拖拽移动：记录按下时光标相对窗体左上角的偏移，之后按光标绝对
        // 位置平移（旧实现只在 MouseDown 里设一次 Location，导致窗口
        // 「跳一下但不跟手」）。
        var dragOffset = System.Drawing.Point.Empty;
        var dragging = false;
        titlebar.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            dragging = true;
            dragOffset = new System.Drawing.Point(Cursor.Position.X - _form.Left, Cursor.Position.Y - _form.Top);
        };
        titlebar.MouseMove += (_, _) =>
        {
            if (!dragging) return;
            _form.Location = new System.Drawing.Point(Cursor.Position.X - dragOffset.X, Cursor.Position.Y - dragOffset.Y);
        };
        titlebar.MouseUp += (_, _) => dragging = false;
        _root.Controls.Add(titlebar, 0, 0);

        // ── 日程概览 ──
        var overview = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.LeftToRight,
            Dock = DockStyle.Fill,
            BackColor = System.Drawing.Color.FromArgb(0xF5, 0xF5, 0xF7),
            Padding = new Padding(12),
            WrapContents = false,
        };
        _scheduleCount = new Label
        {
            Text = "0",
            ForeColor = accent,
            Font = new Font("Microsoft YaHei UI", 20f, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 6, 0),
        };
        var countUnit = new Label
        {
            Text = "个待办日程",
            ForeColor = textPrimary,
            Font = new Font("Microsoft YaHei UI", 9.5f),
            AutoSize = true,
            Margin = new Padding(0, 12, 12, 0),
        };
        _tokenSummary = new Label
        {
            Text = "",
            ForeColor = textMuted,
            Font = new Font("Microsoft YaHei UI", 9.5f),
            AutoSize = true,
            Margin = new Padding(0, 2, 0, 0),
        };
        // 日期行（旧版 schedule-date：2026年9月26日 · 周六）
        _scheduleDate = new Label
        {
            Text = "",
            ForeColor = textMuted,
            AutoSize = true,
            Font = new Font("Microsoft YaHei UI", 9f),
            Margin = new Padding(0, 0, 0, 0),
        };
        var usageColumn = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            AutoSize = true,
            WrapContents = false,
            Margin = new Padding(24, 0, 0, 0),
            BackColor = System.Drawing.Color.Transparent,
        };
        usageColumn.Controls.Add(_scheduleDate);
        usageColumn.Controls.Add(_tokenSummary);
        overview.Controls.Add(_scheduleCount);
        overview.Controls.Add(countUnit);
        overview.Controls.Add(usageColumn);
        _root.Controls.Add(overview, 0, 1);

        // ── 任务列表 ──
        _taskList = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            BackColor = System.Drawing.Color.Transparent,
            Padding = new Padding(0, 8, 0, 8),
        };
        _root.Controls.Add(_taskList, 0, 2);

        // ── token 7 天柱状图 ──
        var chartHost = new Panel { Dock = DockStyle.Fill, BackColor = System.Drawing.Color.Transparent, Padding = new Padding(2, 8, 2, 2) };
        _chartPanel = new Panel { Dock = DockStyle.Fill, BackColor = System.Drawing.Color.Transparent };
        _chartPanel.Paint += DrawWeeklyChart;
        chartHost.Controls.Add(_chartPanel);
        _root.Controls.Add(chartHost, 0, 3);

        _form.Controls.Add(_root);
        _form.FormClosed += (_, _) => RaiseClosed();
        // 圆角：WinForms 无透明窗，用区域裁剪出圆角（与其它原生窗统一）
        ApplyRoundedRegion();
        _form.SizeChanged += (_, _) => ApplyRoundedRegion();

        if (layout.ValueKind == JsonValueKind.Object) ApplyLayout(layout);
    }

    private record TaskRow(string Title, string Time);

    /// <summary>无边框 WinForms 窗的圆角（区域裁剪；失败不影响功能）。</summary>
    private void ApplyRoundedRegion()
    {
        try
        {
            const int radius = 12;
            var previous = _form.Region;
            _form.Region = System.Drawing.Region.FromHrgn(
                NativeMethods.CreateRoundRectRgn(0, 0, _form.Width + 1, _form.Height + 1, radius, radius));
            previous?.Dispose();
        }
        catch { /* 圆角失败不影响功能 */ }
    }

    private List<TaskRow> _tasks = new();
    /// <summary>口径内任务总数（旧版 totalCount）：今日任务优先，否则未来任务；列表只显示前 3 条。</summary>
    private int _scheduleTotal;
    private List<(string Weekday, int Total, bool IsToday, bool IsFuture)> _week = new();

    public void ApplyState(JsonElement tasks, JsonElement usage)
    {
        _tasks.Clear();
        _scheduleTotal = 0;
        // 与旧版 tasks 页 task-filter.ts 同口径：
        //   启用 + nextFireAt 合法 + 未来 → 按触发时间升序；
        //   有今日任务则只取今日，否则取未来；总数 = 口径内数量，列表只显示 3 条。
        if (tasks.ValueKind == JsonValueKind.Array)
        {
            var now = DateTime.Now;
            var upcoming = new List<(DateTime FireAt, string Title, string Kind)>();
            foreach (var t in tasks.EnumerateArray())
            {
                if (t.ValueKind != JsonValueKind.Object) continue;
                // 宿主已按 RendererScheduledTask 投影；enabled = 有效授权状态
                if (!t.TryGetProperty("enabled", out var en) || en.ValueKind != JsonValueKind.True) continue;
                var next = t.TryGetProperty("nextFireAt", out var nf) ? nf.GetString() : null;
                if (string.IsNullOrEmpty(next)
                    || !DateTimeOffset.TryParse(next, System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.RoundtripKind, out var fireAt)) continue;
                var local = fireAt.LocalDateTime;
                if (local < now) continue;

                var title = t.TryGetProperty("title", out var ti) ? ti.GetString() : null;
                // 兼容旧快照的 name 键（宿主投影已统一为 title）
                if (string.IsNullOrEmpty(title) && t.TryGetProperty("name", out var nm)) title = nm.GetString();
                var kind = "";
                if (t.TryGetProperty("schedule", out var sc) && sc.ValueKind == JsonValueKind.Object
                    && sc.TryGetProperty("kind", out var sk)) kind = sk.GetString() ?? "";
                upcoming.Add((local, title ?? "", kind));
            }
            upcoming.Sort((a, b) => a.FireAt.CompareTo(b.FireAt));

            var today = upcoming.Where(x => x.FireAt.Date == now.Date).ToList();
            var source = today.Count > 0 ? today : upcoming;
            var mode = today.Count > 0 ? "today" : (upcoming.Count > 0 ? "upcoming" : "empty");
            _scheduleTotal = source.Count;
            foreach (var entry in source.Take(3))
            {
                // 旧版格式：今日任务显示 HH:mm；未来任务/一次性任务显示 MM-dd HH:mm
                var showDate = mode == "upcoming" || entry.Kind == "once";
                _tasks.Add(new TaskRow(entry.Title, entry.FireAt.ToString(showDate ? "MM-dd HH:mm" : "HH:mm")));
            }
            _scheduleDate.Text =
                $"{now.Year}年{now.Month}月{now.Day}日 · {new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" }[(int)now.DayOfWeek]}";
        }

        // 今日 token 汇总
        var todayText = "";
        if (usage.ValueKind == JsonValueKind.Array && usage.GetArrayLength() > 0)
        {
            var today = usage[0];
            if (today.TryGetProperty("input", out var inp) && inp.TryGetInt32(out var i)
                && today.TryGetProperty("output", out var outp) && outp.TryGetInt32(out var o))
            {
                todayText = $"今日 {FormatTokenShort(i + o)} tokens";
            }
        }
        _tokenSummary.Text = todayText;

        // 7 天柱状图数据
        _week.Clear();
        if (usage.ValueKind == JsonValueKind.Array)
        {
            var byDate = new Dictionary<string, int>();
            foreach (var d in usage.EnumerateArray())
            {
                if (d.TryGetProperty("date", out var dd) && d.TryGetProperty("input", out var di) && d.TryGetProperty("output", out var dou))
                {
                    byDate[dd.GetString() ?? ""] = di.GetInt32() + dou.GetInt32();
                }
            }
            var now = DateTime.Now;
            var weekSunday = now.AddDays(-((int)now.DayOfWeek));
            for (var i = 0; i < 7; i++)
            {
                var day = weekSunday.AddDays(i);
                var key = $"{day.Month:D2}-{day.Day:D2}";
                // 注意：weekSunday 保留了当前时分秒，必须按日期比较，
                // 否则「今天」会被判成未来（柱变虚线 + 今日用量不计入）
                var isFuture = day.Date > now.Date;
                var total = byDate.TryGetValue(key, out var v) && !isFuture ? v : 0;
                _week.Add((new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" }[(int)day.DayOfWeek], total, key == $"{now.Month:D2}-{now.Day:D2}", isFuture));
            }
        }

        RebuildTaskList();
        _chartPanel.Invalidate();
    }

    private void RebuildTaskList()
    {
        _taskList.SuspendLayout();
        _taskList.Controls.Clear();
        if (_tasks.Count == 0)
        {
            var empty = new Label
            {
                Text = "暂无已启用定时任务",
                ForeColor = System.Drawing.Color.FromArgb(0x6F, 0x68, 0x76),
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 9.5f),
                Padding = new Padding(4, 10, 4, 10),
            };
            _taskList.Controls.Add(empty);
        }
        else
        {
            foreach (var t in _tasks)
            {
                var item = new Panel
                {
                    Width = Math.Max(_taskList.ClientSize.Width - 24, 120),
                    Height = 40,
                    BackColor = System.Drawing.Color.FromArgb(0xF7, 0xF7, 0xFA),
                    Margin = new Padding(0, 3, 0, 3),
                };
                var name = new Label
                {
                    Text = t.Title,
                    ForeColor = System.Drawing.Color.FromArgb(0x1D, 0x1D, 0x1F),
                    AutoSize = false,
                    Width = item.Width - 70,
                    Height = 36,
                    Location = new System.Drawing.Point(10, 2),
                    TextAlign = System.Drawing.ContentAlignment.MiddleLeft,
                    Font = new Font("Microsoft YaHei UI", 9.5f),
                };
                var time = new Label
                {
                    Text = t.Time,
                    ForeColor = System.Drawing.Color.FromArgb(0xE8, 0x4A, 0x78),
                    AutoSize = false,
                    Width = 78,
                    Height = 36,
                    Location = new System.Drawing.Point(item.Width - 86, 2),
                    TextAlign = System.Drawing.ContentAlignment.MiddleRight,
                    Font = new Font("Microsoft YaHei UI", 9f),
                };
                item.Controls.Add(name);
                item.Controls.Add(time);
                _taskList.Controls.Add(item);
            }
        }
        // 计数 = 口径内总数（旧版 totalCount）：列表最多 3 条，计数不随之截断
        _scheduleCount.Text = _scheduleTotal.ToString();
        _taskList.ResumeLayout();
    }

    private void DrawWeeklyChart(object? sender, PaintEventArgs e)
    {
        // 索引安全 + 绘制异常兜底：Paint 抛异常会变成 UI 线程未处理异常，
        // 直接带走整个 cyrene-native 进程（用户报「日程页拖动后闪退」）。
        if (_week.Count < 7) return;
        try
        {
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var plot = new System.Drawing.Rectangle(6, 4, Math.Max(_chartPanel.ClientSize.Width - 12, 40), Math.Max(_chartPanel.ClientSize.Height - 26, 40));
            var slot = plot.Width / 7.0;
            var maxVal = Math.Max(_week.Where(w => !w.IsFuture).Select(w => w.Total).DefaultIfEmpty(0).Max(), 1);

            for (var i = 0; i < 7; i++)
            {
                var (weekday, total, isToday, isFuture) = _week[i];
                var barWidth = Math.Max((int)(slot * 0.52), 1);
                var x = (int)(plot.X + i * slot + (slot - barWidth) / 2);

                if (isFuture)
                {
                    // 未来留空柱（虚线框，pearl-white 弱化描边）
                    using var pen = new Pen(System.Drawing.Color.FromArgb(0x80, 0xD2, 0xD2, 0xD7), 1) { DashStyle = System.Drawing.Drawing2D.DashStyle.Dot };
                    g.DrawRectangle(pen, x, plot.Bottom - 48, barWidth, 48);
                }
                else
                {
                    var h = Math.Max((int)(48.0 * total / maxVal), total > 0 ? 4 : 0);
                    var color = isToday
                        ? System.Drawing.Color.FromArgb(0xFF, 0x5B, 0x8A)
                        : System.Drawing.Color.FromArgb(0xFF, 0xB1, 0xCB);
                    using var brush = new SolidBrush(color);
                    g.FillRectangle(brush, x, plot.Bottom - h, barWidth, h);
                    if (total > 0)
                    {
                        using var font = new Font("Microsoft YaHei UI", 7.5f);
                        using var textBrush = new SolidBrush(System.Drawing.Color.FromArgb(0x6F, 0x68, 0x76));
                        var txt = FormatTokenShort(total);
                        var size = g.MeasureString(txt, font);
                        g.DrawString(txt, font, textBrush, (float)(x + barWidth / 2.0 - size.Width / 2), plot.Bottom - h - 14);
                    }
                }
                // 星期标签
                using var lblFont = new Font("Microsoft YaHei UI", 8.5f);
                using var lblBrush = new SolidBrush(isToday
                    ? System.Drawing.Color.FromArgb(0xE8, 0x4A, 0x78)
                    : System.Drawing.Color.FromArgb(0x6F, 0x68, 0x76));
                var lblSize = g.MeasureString(weekday, lblFont);
                g.DrawString(weekday, lblFont, lblBrush, (float)(x + barWidth / 2.0 - lblSize.Width / 2), (float)(plot.Bottom + 4));
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[TasksWindow] weekly chart paint failed: {ex.Message}");
        }
    }

    private static string FormatTokenShort(int tokens) => tokens >= 1000 ? $"{tokens / 1000.0:F1}k" : tokens.ToString();

    private Button MakeTitleButton(string glyph, Action onClick)
    {
        var btn = new Button
        {
            Text = glyph,
            FlatStyle = FlatStyle.Flat,
            ForeColor = System.Drawing.Color.FromArgb(0x6F, 0x68, 0x76),
            BackColor = System.Drawing.Color.Transparent,
            // FlatAppearance.BorderSize 通过初始化后设置
            TabStop = false,
            Size = new Size(28, 24),
            Font = new Font("Consolas", 9f),
        };
        btn.FlatAppearance.BorderSize = 0;
        btn.FlatAppearance.MouseOverBackColor = System.Drawing.Color.FromArgb(0xFF, 0xD6, 0xE4);
        btn.FlatAppearance.MouseDownBackColor = System.Drawing.Color.FromArgb(0xFF, 0xB1, 0xCB);
        btn.Click += (_, _) => onClick();
        return btn;
    }

    public override void ShowWindow()
    {
        if (!_form.Visible) _form.Show();
        _form.Activate();
    }

    public override void Activate()
    {
        if (!_form.Visible) _form.Show();
        if (_form.WindowState == FormWindowState.Minimized) _form.WindowState = FormWindowState.Normal;
        _form.Activate();
        _form.BringToFront();
    }
    // 路由调用全部在 WPF Dispatcher（UI 线程）上：Form.Close 直接调。
    // 不用 Form.Invoke——WinForms 控件寄宿在 WPF Dispatcher 线程时无
    // WinForms SynchronizationContext，Invoke 会抛
    // InvalidOperationException（句柄未创建/无 marshaling 上下文）。
    public override void Close() => _form.Close();

    public override void ApplyLayout(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object) return;
        if (!layout.TryGetProperty("tasks", out var tasks)) return;
        // 构造已设 StartPosition=Manual；此处只更新坐标（x/y 各自独立生效）
        if (tasks.TryGetProperty("x", out var x) && x.TryGetInt32(out var xi))
            _form.Location = new System.Drawing.Point(xi, _form.Location.Y);
        if (tasks.TryGetProperty("y", out var y) && y.TryGetInt32(out var yi))
            _form.Location = new System.Drawing.Point(_form.Location.X, yi);
    }
}
