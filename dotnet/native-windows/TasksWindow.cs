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
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual,
            Size = new Size(360, 760),
            MinimumSize = new Size(300, 540),
            ShowInTaskbar = false,
            BackColor = System.Drawing.Color.FromArgb(0x26, 0x26, 0x3E),
            TopMost = false,
        };

        // 深色字色 token（对齐 tasks.css 粉紫系）
        var textPrimary = System.Drawing.Color.FromArgb(0xF0, 0xFF, 0xE3, 0xF2);

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
        var titlebar = new TableLayoutPanel { ColumnCount = 3, Dock = DockStyle.Fill, BackColor = System.Drawing.Color.Transparent };
        titlebar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
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
        var minBtn = MakeTitleButton("—", () => _form.WindowState = FormWindowState.Minimized);
        var closeBtn = MakeTitleButton("✕", _form.Close);
        titlebar.Controls.Add(minBtn, 1, 0);
        titlebar.Controls.Add(closeBtn, 2, 0);
        // 拖拽移动
        titlebar.MouseDown += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
                _form.Location = new System.Drawing.Point(Cursor.Position.X - e.X, Cursor.Position.Y - e.Y);
        };
        _root.Controls.Add(titlebar, 0, 0);

        // ── 日程概览 ──
        var overview = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.LeftToRight,
            Dock = DockStyle.Fill,
            BackColor = System.Drawing.Color.FromArgb(0x33, 0x2B, 0x2B, 0x4A),
            Padding = new Padding(12),
            WrapContents = false,
        };
        _scheduleCount = new Label
        {
            Text = "0",
            ForeColor = System.Drawing.Color.FromArgb(0xE4, 0x99, 0xFF),
            Font = new Font("Microsoft YaHei UI", 20f, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 6, 0),
        };
        var countUnit = new Label
        {
            Text = "个待办日程",
            ForeColor = textPrimary,
            AutoSize = true,
            Margin = new Padding(0, 12, 12, 0),
        };
        _tokenSummary = new Label
        {
            Text = "",
            ForeColor = System.Drawing.Color.FromArgb(0xCC, 0xCC, 0xD8),
            AutoSize = true,
            Margin = new Padding(0, 42, 0, 0),
        };
        overview.Controls.Add(_scheduleCount);
        overview.Controls.Add(countUnit);
        overview.Controls.Add(_tokenSummary);
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

        if (layout.ValueKind == JsonValueKind.Object) ApplyLayout(layout);
    }

    private record TaskRow(string Name, string Time, bool Enabled);

    private List<TaskRow> _tasks = new();
    private List<(string Weekday, int Total, bool IsToday, bool IsFuture)> _week = new();

    public void ApplyState(JsonElement tasks, JsonElement usage)
    {
        _tasks.Clear();
        if (tasks.ValueKind == JsonValueKind.Array)
        {
            foreach (var t in tasks.EnumerateArray())
            {
                var name = t.TryGetProperty("name", out var n) ? n.GetString() : "";
                var time = "";
                if (t.TryGetProperty("time", out var tm))
                {
                    time = tm.ValueKind switch
                    {
                        JsonValueKind.String => tm.GetString() ?? "",
                        JsonValueKind.Number => tm.GetDouble().ToString("0.####"),
                        _ => "",
                    };
                }
                var enabled = !t.TryGetProperty("enabled", out var en) || (en.ValueKind == JsonValueKind.True);
                _tasks.Add(new TaskRow(name ?? "", time, enabled));
            }
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
                var isFuture = day > now.Date;
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
                ForeColor = System.Drawing.Color.FromArgb(0x99, 0xCC, 0xCC, 0xD8),
                AutoSize = true,
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
                    BackColor = System.Drawing.Color.FromArgb(0x22, 0x33, 0x33, 0x50),
                    Margin = new Padding(0, 3, 0, 3),
                };
                var name = new Label
                {
                    Text = t.Name,
                    ForeColor = System.Drawing.Color.FromArgb(0xF0, 0xFF, 0xE3, 0xF2),
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
                    ForeColor = System.Drawing.Color.FromArgb(0xB3, 0xE4, 0x99, 0xFF),
                    AutoSize = false,
                    Width = 58,
                    Height = 36,
                    Location = new System.Drawing.Point(item.Width - 66, 2),
                    TextAlign = System.Drawing.ContentAlignment.MiddleRight,
                    Font = new Font("Microsoft YaHei UI", 9f),
                };
                if (!t.Enabled)
                {
                    name.ForeColor = System.Drawing.Color.FromArgb(0x77, 0xCC, 0xCC, 0xD8);
                    time.ForeColor = System.Drawing.Color.FromArgb(0x77, 0xE4, 0x99, 0xFF);
                }
                item.Controls.Add(name);
                item.Controls.Add(time);
                _taskList.Controls.Add(item);
            }
        }
        _scheduleCount.Text = _tasks.Count.ToString();
        _taskList.ResumeLayout();
    }

    private void DrawWeeklyChart(object? sender, PaintEventArgs e)
    {
        if (_week.Count == 0) return;
        var g = e.Graphics;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        var plot = new System.Drawing.Rectangle(6, 4, _chartPanel.ClientSize.Width - 12, _chartPanel.ClientSize.Height - 26);
        var slot = plot.Width / 7.0;
        var maxVal = Math.Max(_week.Where(w => !w.IsFuture).Select(w => w.Total).DefaultIfEmpty(0).Max(), 1);

        for (var i = 0; i < 7; i++)
        {
            var (weekday, total, isToday, isFuture) = _week[i];
            var barWidth = (int)(slot * 0.52);
            var x = (int)(plot.X + i * slot + (slot - barWidth) / 2);
            var label = new Label();

            if (isFuture)
            {
                // 未来留空柱（虚线框）
                using var pen = new Pen(System.Drawing.Color.FromArgb(0x33, 0xFF, 0xE3, 0xF2), 1) { DashStyle = System.Drawing.Drawing2D.DashStyle.Dot };
                g.DrawRectangle(pen, x, plot.Bottom - 48, barWidth, 48);
            }
            else
            {
                var h = Math.Max((int)(48.0 * total / maxVal), total > 0 ? 4 : 0);
                var color = isToday
                    ? System.Drawing.Color.FromArgb(0xE4, 0x99, 0xFF)
                    : System.Drawing.Color.FromArgb(0x99, 0xC9, 0x8C, 0xFF);
                using var brush = new SolidBrush(color);
                g.FillRectangle(brush, x, plot.Bottom - h, barWidth, h);
                if (total > 0)
                {
                    using var font = new Font("Microsoft YaHei UI", 7.5f);
                    using var textBrush = new SolidBrush(System.Drawing.Color.FromArgb(0xB3, 0xCC, 0xCC, 0xD8));
                    var txt = FormatTokenShort(total);
                    var size = g.MeasureString(txt, font);
                    g.DrawString(txt, font, textBrush, (float)(x + barWidth / 2.0 - size.Width / 2), plot.Bottom - h - 14);
                }
            }
            // 星期标签
            using var lblFont = new Font("Microsoft YaHei UI", 8.5f);
            using var lblBrush = new SolidBrush(isToday
                ? System.Drawing.Color.FromArgb(0xE4, 0x99, 0xFF)
                : System.Drawing.Color.FromArgb(0x8C, 0xCC, 0xCC, 0xD8));
            var lblSize = g.MeasureString(weekday, lblFont);
            g.DrawString(weekday, lblFont, lblBrush, (float)(x + barWidth / 2.0 - lblSize.Width / 2), (float)(plot.Bottom + 4));
        }
    }

    private static string FormatTokenShort(int tokens) => tokens >= 1000 ? $"{tokens / 1000.0:F1}k" : tokens.ToString();

    private Button MakeTitleButton(string glyph, Action onClick)
    {
        var btn = new Button
        {
            Text = glyph,
            FlatStyle = FlatStyle.Flat,
            ForeColor = System.Drawing.Color.FromArgb(0xCC, 0xFF, 0xE3, 0xF2),
            BackColor = System.Drawing.Color.Transparent,
            // FlatAppearance.BorderSize 通过初始化后设置
            TabStop = false,
            Size = new Size(28, 24),
            Font = new Font("Consolas", 9f),
        };
        btn.FlatAppearance.BorderSize = 0;
        btn.FlatAppearance.MouseOverBackColor = System.Drawing.Color.FromArgb(0x40, 0xC9, 0x8C, 0xFF);
        btn.Click += (_, _) => onClick();
        return btn;
    }

    public override void ShowWindow() => _form.Show();
    public override void Activate() => _form.Activate();
    // 路由调用全部在 WPF Dispatcher（UI 线程）上：Form.Close 直接调。
    // 不用 Form.Invoke——WinForms 控件寄宿在 WPF Dispatcher 线程时无
    // WinForms SynchronizationContext，Invoke 会抛
    // InvalidOperationException（句柄未创建/无 marshaling 上下文）。
    public override void Close() => _form.Close();

    public override void ApplyLayout(JsonElement layout)
    {
        if (layout.ValueKind != JsonValueKind.Object) return;
        if (!layout.TryGetProperty("tasks", out var tasks)) return;
        if (tasks.TryGetProperty("x", out var x) && x.TryGetInt32(out var xi)) _form.StartPosition = FormStartPosition.Manual;
        if (tasks.TryGetProperty("x", out var x2) && x2.TryGetInt32(out var x2i)) _form.Location = new System.Drawing.Point(x2i, _form.Location.Y);
        if (tasks.TryGetProperty("y", out var y) && y.TryGetInt32(out var yi)) _form.Location = new System.Drawing.Point(_form.Location.X, yi);
    }
}
