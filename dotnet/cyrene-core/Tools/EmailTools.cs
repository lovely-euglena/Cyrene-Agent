using System.Text.Json;
using System.Text.RegularExpressions;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Smtp;
using MailKit.Search;
using MailKit.Security;
using MimeKit;

namespace CyreneNative.Tools;

/// <summary>
/// 邮件四件（send_email / email_list / email_read / email_mark；IKJK3V T2 库替代批）。
///
/// 库替代：nodemailer → MailKit SmtpClient；imapflow + mailparser → MailKit ImapClient + MimeKit。
///   - 配置（SMTP/IMAP 主机、端口、TLS、账号、授权码、发件人）经 config 帧注入
///     （B1：仅宿主内存驻留，不落盘；TS 每次调用前实时刷新）；
///   - 校验文案与 TS 逐字对齐（未启用 / 配置不完整 / 收件人无效 / uid 无效等），
///     校验失败按普通结果返回（不回退）；收信连接/协议失败抛错误帧 → TS 包装层回退原实现；
///     send_email 分两段：组装/连接/认证等前置失败抛 E_EMAIL_PRECONDITION（确定未发出，
///     TS 侧可安全回退）；Send 阶段失败抛 E_EMAIL_SEND（状态可能未知，TS 不自动重发避免重复投递）；
///     发送成功后的断开失败仅日志，不计入发送失败（防 TS 误判触发重复投递）。
///   - 发信确认卡在 TS（B2 审批在 Electron），本工具只做确认后的实际发送；
///   - email_read 正文 4000 字符截断（附"…（正文已截断）"），默认标记已读（失败不阻断阅读）。
/// </summary>
internal static class EmailTools
{
    private const int EmailBodyLimit = 4000;
    private const int ClientTimeoutMs = 30_000;

    private static readonly Regex EmailRegex = new(@"^[^\s@]+@[^\s@]+\.[^\s@]+$", RegexOptions.Compiled);

    // ── send_email（SMTP）──────────────────────────────────

    public static string Send(JsonElement args)
    {
        if (!ToolHostConfig.EmailEnabled) return "[错误] 邮件功能未启用，请在设置里开启";
        var host = ToolHostConfig.EmailSmtpHost;
        var user = ToolHostConfig.EmailUser;
        var pass = ToolHostConfig.EmailPass;
        if (host.Length == 0 || user.Length == 0 || pass.Length == 0)
            return "[错误] SMTP 配置不完整：缺少 主机/用户名/授权码";
        var port = ToolHostConfig.EmailSmtpPort;
        var secure = ToolHostConfig.EmailSmtpSecure;
        var fromName = ToolHostConfig.EmailFromName;

        var to = ReadAddresses(args, "to");
        if (to.Count == 0) return "[错误] 收件人列表为空";
        foreach (var addr in to)
            if (!EmailRegex.IsMatch(addr)) return $"[错误] 收件人邮箱无效：{addr}";
        var cc = ReadAddresses(args, "cc");
        foreach (var addr in cc)
            if (!EmailRegex.IsMatch(addr)) return $"[错误] 抄送邮箱无效：{addr}";

        var subject = Str(args, "subject").Trim();
        var body = Str(args, "body").Trim();
        var html = Str(args, "html");
        if (subject.Length == 0) return "[错误] 邮件主题不能为空";
        if (body.Length == 0 && html.Length == 0) return "[错误] 邮件正文不能为空";

        var attachments = ReadAddresses(args, "attachments");
        foreach (var p in attachments)
            if (!File.Exists(p)) return $"[错误] 附件不存在：{p}";

        var client = new SmtpClient { Timeout = ClientTimeoutMs };
        try
        {
            MimeMessage message;
            try
            {
                message = new MimeMessage();
                message.From.Add(new MailboxAddress(fromName, user));
                foreach (var addr in to) message.To.Add(MailboxAddress.Parse(addr));
                foreach (var addr in cc) message.Cc.Add(MailboxAddress.Parse(addr));
                message.Subject = subject;
                var builder = new BodyBuilder();
                if (body.Length > 0) builder.TextBody = body;
                if (html.Length > 0) builder.HtmlBody = html;
                foreach (var p in attachments) builder.Attachments.Add(p);
                message.Body = builder.ToMessageBody();
            }
            catch (Exception ex)
            {
                // 组装阶段（附件读取/地址解析）失败：确定未进入发送
                throw new ToolHostException("E_EMAIL_PRECONDITION", "发送失败（未进入发送阶段）：" + ex.Message);
            }

            try
            {
                client.Connect(host, port, secure ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTlsWhenAvailable);
                client.Authenticate(user, pass);
            }
            catch (Exception ex)
            {
                // 前置阶段（连接/认证）失败：主机不可达、授权码错误等确定未发出；
                // 独立错误码 E_EMAIL_PRECONDITION，TS 侧按确定失败安全回退（复审 P2-3）
                throw new ToolHostException("E_EMAIL_PRECONDITION", "发送失败（未进入发送阶段）：" + ex.Message);
            }

            try
            {
                client.Send(message);
            }
            catch (Exception ex)
            {
                // 发送阶段失败：可能发生在服务器已收件、确认未回之后 → 状态未知
                // （E_EMAIL_SEND）；TS 包装层不自动重发（避免重复投递）
                throw new ToolHostException("E_EMAIL_SEND", "发送失败：" + ex.Message);
            }
        }
        finally
        {
            // 断开失败不属于发送失败：服务器已收件，若在此抛错会让 TS 误判未发送
            // 而触发回退重发（重复投递窗口）。仅日志。
            try { client.Disconnect(true); }
            catch (Exception ex) { Console.Error.WriteLine("[EmailTools] SMTP 断开失败（已发送，忽略）：" + ex.Message); }
            try { client.Dispose(); } catch { /* 释放失败忽略 */ }
        }
        return $"[send_email] 已发送：{string.Join(", ", to)} 主题：{subject}";
    }

    // ── 收信（IMAP）────────────────────────────────────────

    private sealed record ImapConfig(string Host, int Port, bool Secure, string User, string Pass);

    /// <summary>读取并校验 IMAP 配置；未配置/缺凭据时返回可展示的错误字符串。</summary>
    private static (ImapConfig? Config, string? Error) ReadImapConfig()
    {
        if (!ToolHostConfig.EmailEnabled) return (null, "[错误] 邮件功能未启用，请在设置里开启");
        var host = ToolHostConfig.EmailImapHost;
        var user = ToolHostConfig.EmailUser;
        var pass = ToolHostConfig.EmailPass;
        if (host.Length == 0)
            return (null, "[错误] IMAP 未配置：请在设置 → 插件 → 邮件 填写 IMAP 服务器（收信与发信共用邮箱与授权码）");
        if (user.Length == 0 || pass.Length == 0)
            return (null, "[错误] IMAP 配置不完整：缺少发件邮箱/授权码（收信与发信共用）");
        return (new ImapConfig(host, ToolHostConfig.EmailImapPort, ToolHostConfig.EmailImapSecure, user, pass), null);
    }

    private static ImapClient ConnectImap(ImapConfig cfg)
    {
        var client = new ImapClient { Timeout = ClientTimeoutMs };
        try
        {
            client.Connect(cfg.Host, cfg.Port, cfg.Secure ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTlsWhenAvailable);
            client.Authenticate(cfg.User, cfg.Pass);
            return client;
        }
        catch
        {
            try { client.Dispose(); } catch { /* 已断开 */ }
            throw;
        }
    }

    public static string List(JsonElement args)
    {
        var (cfg, error) = ReadImapConfig();
        if (error is not null) return error;
        var folderName = ReadMailbox(args);
        var limit = ClampLimit(args);
        var unreadOnly = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("unreadOnly", out var u) && u.ValueKind == JsonValueKind.True;
        var search = Str(args, "search").Trim().ToLowerInvariant();

        try
        {
            using var client = ConnectImap(cfg!);
            var folder = client.GetFolder(folderName);
            folder.Open(FolderAccess.ReadOnly);
            try
            {
                var uids = folder.Search(unreadOnly ? SearchQuery.NotSeen : SearchQuery.All);
                var recent = uids.Skip(Math.Max(0, uids.Count - limit)).Reverse().ToList();
                if (recent.Count == 0)
                    return unreadOnly ? $"[email_list] {folderName} 没有未读邮件" : $"[email_list] {folderName} 为空";

                var summaries = folder.Fetch(recent, MessageSummaryItems.UniqueId | MessageSummaryItems.Envelope | MessageSummaryItems.Flags);
                var byUid = summaries.ToDictionary(s => s.UniqueId);
                var lines = new List<string>();
                foreach (var uid in recent)
                {
                    if (!byUid.TryGetValue(uid, out var summary)) continue;
                    var from = FormatAddress(summary.Envelope?.From?.FirstOrDefault());
                    var subject = summary.Envelope?.Subject is { Length: > 0 } s ? s : "(无主题)";
                    if (search.Length > 0 && !($"{subject} {from}").ToLowerInvariant().Contains(search)) continue;
                    var date = summary.Envelope?.Date is { } d ? d.ToLocalTime().ToString("yyyy/M/d HH:mm:ss") : "";
                    var seen = summary.Flags?.HasFlag(MessageFlags.Seen) == true ? "已读" : "未读";
                    lines.Add($"- uid={uid.Id} · {seen} · {date} · 发件人：{from}\n  主题：{subject}");
                }
                if (lines.Count == 0)
                    return $"[email_list] 最近 {recent.Count} 封中没有匹配「{search}」的邮件";
                var scope = unreadOnly ? "未读" : "共";
                return $"[email_list] {folderName} {scope} {uids.Count} 封；最近 {lines.Count} 封：\n" + string.Join("\n", lines);
            }
            finally
            {
                try { folder.Close(false); } catch { /* 已关闭 */ }
            }
        }
        catch (Exception ex) when (ex is not ToolHostException)
        {
            throw new ToolHostException("E_EMAIL_IMAP", "邮箱操作失败：" + ex.Message);
        }
    }

    public static string Read(JsonElement args)
    {
        var (cfg, error) = ReadImapConfig();
        if (error is not null) return error;
        var uid = ReadUid(args);
        if (uid is null) return "[错误] 缺少有效的邮件 uid（先用 email_list 获取 uid）";
        var folderName = ReadMailbox(args);
        var markSeen = !(args.ValueKind == JsonValueKind.Object && args.TryGetProperty("markSeen", out var m) && m.ValueKind == JsonValueKind.False);

        try
        {
            using var client = ConnectImap(cfg!);
            var folder = client.GetFolder(folderName);
            folder.Open(FolderAccess.ReadWrite);
            try
            {
                var uniqueId = new UniqueId(uid.Value);
                MimeMessage message;
                try
                {
                    message = folder.GetMessage(uniqueId);
                }
                catch (MessageNotFoundException)
                {
                    return $"[错误] 未找到 uid={uid} 的邮件（folder={folderName}）";
                }
                var text = (message.TextBody ?? "").Trim();
                var bodyText = text.Length > EmailBodyLimit ? text[..EmailBodyLimit] + "\n…（正文已截断）" : text;
                var toText = string.Join(", ", message.To.Mailboxes.Select(mb => FormatAddress(mb)));
                var fromText = message.From.Count > 0
                    ? string.Join(", ", message.From.Mailboxes.Select(mb => FormatAddress(mb)))
                    : "(未知)";
                var attachments = message.Attachments.ToList();
                var attachmentNames = attachments.Count > 0
                    ? string.Join("、", attachments.Select(FormatAttachment))
                    : "（无）";
                if (markSeen)
                {
                    try { folder.AddFlags(uniqueId, MessageFlags.Seen, true); } catch { /* 标记失败不影响阅读 */ }
                }
                var dateText = message.Date != default ? message.Date.ToLocalTime().ToString("yyyy/M/d HH:mm:ss") : "(未知)";
                return string.Join("\n", new[]
                {
                    $"[email_read] uid={uid}（folder={folderName}）",
                    $"主题：{(string.IsNullOrEmpty(message.Subject) ? "(无主题)" : message.Subject)}",
                    $"发件人：{fromText}",
                    $"收件人：{(toText.Length > 0 ? toText : "(未知)")}",
                    $"时间：{dateText}",
                    $"附件：{attachmentNames}",
                    "",
                    bodyText.Length > 0 ? bodyText : "（无纯文本正文；如需 HTML 原文请告知）",
                });
            }
            finally
            {
                try { folder.Close(false); } catch { /* 已关闭 */ }
            }
        }
        catch (Exception ex) when (ex is not ToolHostException)
        {
            throw new ToolHostException("E_EMAIL_IMAP", "邮箱操作失败：" + ex.Message);
        }
    }

    public static string Mark(JsonElement args)
    {
        var (cfg, error) = ReadImapConfig();
        if (error is not null) return error;
        var uid = ReadUid(args);
        if (uid is null) return "[错误] 缺少有效的邮件 uid（先用 email_list 获取 uid）";
        var folderName = ReadMailbox(args);
        var seen = !(args.ValueKind == JsonValueKind.Object && args.TryGetProperty("seen", out var s) && s.ValueKind == JsonValueKind.False);

        try
        {
            using var client = ConnectImap(cfg!);
            var folder = client.GetFolder(folderName);
            folder.Open(FolderAccess.ReadWrite);
            try
            {
                var uniqueId = new UniqueId(uid.Value);
                if (seen) folder.AddFlags(uniqueId, MessageFlags.Seen, true);
                else folder.RemoveFlags(uniqueId, MessageFlags.Seen, true);
                return $"[email_mark] uid={uid} 已标记为{(seen ? "已读" : "未读")}（folder={folderName}）";
            }
            finally
            {
                try { folder.Close(false); } catch { /* 已关闭 */ }
            }
        }
        catch (Exception ex) when (ex is not ToolHostException)
        {
            throw new ToolHostException("E_EMAIL_IMAP", "邮箱操作失败：" + ex.Message);
        }
    }

    // ── 通用 ────────────────────────────────────────────────

    private static string FormatAddress(InternetAddress? address)
    {
        if (address is MailboxAddress mailbox)
            return string.IsNullOrEmpty(mailbox.Name) ? mailbox.Address : $"{mailbox.Name} <{mailbox.Address}>";
        return address?.ToString() ?? "(未知发件人)";
    }

    private static string FormatAttachment(MimeEntity entity)
    {
        var fileName = entity is MimePart part ? part.FileName : null;
        var size = entity is MimePart p2 ? p2.ContentDisposition?.Size ?? 0 : 0;
        var name = string.IsNullOrEmpty(fileName) ? "(未命名)" : fileName;
        return size > 0 ? $"{name} ({Math.Round(size / 1024.0)}KB)" : name;
    }

    private static string ReadMailbox(JsonElement args)
    {
        var folder = Str(args, "folder").Trim();
        return folder.Length > 0 ? folder : "INBOX";
    }

    private static uint? ReadUid(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("uid", out var v)) return null;
        double value = v.ValueKind switch
        {
            JsonValueKind.Number => v.GetDouble(),
            JsonValueKind.String when double.TryParse(v.GetString(), out var d) => d,
            _ => double.NaN,
        };
        if (double.IsNaN(value) || double.IsInfinity(value) || value <= 0) return null;
        var rounded = Math.Round(value);
        if (rounded < 1 || rounded > uint.MaxValue) return null;
        return (uint)rounded;
    }

    private static int ClampLimit(JsonElement args)
    {
        double raw = 10;
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("limit", out var v))
        {
            raw = v.ValueKind switch
            {
                JsonValueKind.Number => v.GetDouble(),
                JsonValueKind.String when double.TryParse(v.GetString(), out var d) => d,
                _ => double.NaN,
            };
        }
        if (double.IsNaN(raw) || double.IsInfinity(raw)) raw = 10;
        return Math.Clamp((int)Math.Round(raw), 1, 50);
    }

    private static List<string> ReadAddresses(JsonElement args, string key)
    {
        var list = new List<string>();
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array)
            return list;
        foreach (var item in arr.EnumerateArray())
        {
            var value = item.ValueKind == JsonValueKind.String ? item.GetString()!.Trim() : "";
            if (value.Length > 0) list.Add(value);
        }
        return list;
    }

    private static string Str(JsonElement el, string key)
        => el.ValueKind == JsonValueKind.Object && el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : "";
}
