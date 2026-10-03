using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CyreneNative.Tools;

/// <summary>
/// git 工具（status / init / commit / switch_branch / push / revert / diff / log）——
/// 与 git-tools.ts + code-git/git-service.ts 同语义（simple-git 3.36 命令与解析逐条对齐）。
///
/// 信任边界：workspaceRoot / git 可执行 / 提交身份均由 TS 包装器从 ToolContext 与
/// GitService 注入内部参数（__cyreneRoot / __gitCommand / __gitSource / __gitVersion /
/// __gitIsolated / __gitIdentity / __sessionId），模型参数不参与。
/// 凭证：完全沿用系统 git 凭据链（helper/环境），宿主不接触也不落盘任何凭证（B1）。
/// 取消：在途取消由 NativeToolHost 杀 host 中止（git 子进程可能短暂孤儿化，见设计稿 §2）。
/// 错误：校验/命令失败抛错误帧 → TS 包装层回退 GitService 原实现（错误语义一致）。
/// </summary>
internal static class GitTools
{
    // 内部 IPC 载荷：仅经帧协议回传 TS/模型，不直接注入 DOM；与
    // ExpenseTools/ApplyPatchTool 同约定（中文不转 \uXXXX，原始 JSON 与 TS 侧对齐）
    private static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private const int CommandTimeoutMs = 120_000;

    // ── 公共入口 ─────────────────────────────────────────────

    public static string Status(JsonElement args)
    {
        var root = Root(args);
        var sessionId = Str(args, "__sessionId");
        if (!IsRepository(args, root))
            return EmptyStatusJson(sessionId, "not_repository", "这个目录还不是 Git 仓库");

        var summary = RunStatusSummary(args, root);
        var branches = RunBranches(args, root);
        var (insertions, deletions, byPath) = LineStats(args, root, summary.Files);
        var conflicted = new HashSet<string>(summary.Conflicted, StringComparer.Ordinal);

        var files = new List<Dictionary<string, object?>>();
        var summaryCounts = new Dictionary<string, int>
        {
            ["added"] = 0, ["modified"] = 0, ["deleted"] = 0, ["renamed"] = 0, ["conflicted"] = 0,
        };
        foreach (var file in summary.Files)
        {
            var kind = ClassifyKind(file, conflicted.Contains(file.Path));
            summaryCounts[kind]++;
            var lines = byPath.TryGetValue(file.Path, out var v) ? v : (0, 0);
            var change = new Dictionary<string, object?> { ["path"] = file.Path };
            if (file.FromPath is not null) change["fromPath"] = file.FromPath;
            change["kind"] = kind;
            change["staged"] = file.Index != ' ' && file.Index != '?';
            change["unstaged"] = file.WorkingDir != ' ' && file.WorkingDir != '?';
            change["insertions"] = lines.Item1;
            change["deletions"] = lines.Item2;
            files.Add(change);
        }

        var raw = summary.Current ?? "HEAD";
        var output = new Dictionary<string, object?>
        {
            ["sessionId"] = sessionId,
            ["state"] = "ready",
            ["executable"] = new Dictionary<string, object?>
            {
                ["source"] = Str(args, "__gitSource"),
                ["version"] = Str(args, "__gitVersion"),
            },
            ["branch"] = new Dictionary<string, object?>
            {
                ["current"] = raw == "HEAD" ? null : raw,
                ["detached"] = raw == "HEAD",
                ["branches"] = branches,
                ["tracking"] = summary.Tracking,
            },
            ["files"] = files,
            ["summary"] = summaryCounts,
            ["lines"] = new Dictionary<string, object?> { ["insertions"] = insertions, ["deletions"] = deletions },
            ["ahead"] = summary.Ahead,
            ["behind"] = summary.Behind,
        };
        return Serialize(output);
    }

    public static string Init(JsonElement args)
    {
        var root = Root(args);
        var result = RunGit(args, root, Concat(BaseConfig(args), new[] { "init" }));
        if (result.ExitCode != 0) throw GitFailed("git init", result);
        return "已初始化 Git 仓库";
    }

    public static string Commit(JsonElement args)
    {
        var root = Root(args);
        var message = Str(args, "message").Trim();
        if (message.Length == 0) throw new ToolHostException("E_GIT_INPUT", "缺少有效参数：message");
        var paths = StringArray(args, "paths");
        if (paths.Count == 0 || paths.Any(p => !IsSafeRelativePath(p)))
            throw new ToolHostException("E_GIT_INPUT", "请提供要提交的仓库内文件路径");

        var identity = GitIdentity(args);
        var email = identity?.Email?.Trim() ?? "";
        if (email.Length == 0)
            throw new ToolHostException("E_GIT_IDENTITY",
                "尚未配置 Git 提交邮箱：请在 设置 → 通用设置 → 「Git 提交身份」填写邮箱（提交作者名默认 Cyrene）");
        var name = identity?.Name?.Trim() is { Length: > 0 } n ? n : "Cyrene";

        var status = RunStatusSummary(args, root);
        if (status.Conflicted.Count > 0)
            throw new ToolHostException("E_GIT_CONFLICT", "存在冲突文件，请先处理冲突后再提交");

        var add = RunGit(args, root, Concat(BaseConfig(args), new[] { "add", "-A", "--" }, paths));
        if (add.ExitCode != 0) throw GitFailed("git add", add);

        var config = BaseConfig(args, new GitIdentityInfo(name, email));
        var commitArgs = Concat(config, new[] { "-c", "core.abbrev=40", "commit", "-m", message });
        var result = RunGit(args, root, commitArgs);
        if (result.ExitCode != 0) throw GitFailed("git commit", result);

        var match = Regex.Match(result.Stdout, @"^\[([^\s]+)( \([^)]+\))? ([^\]]+)", RegexOptions.Multiline);
        var hash = match.Success ? match.Groups[3].Value : "";
        return hash.Length > 0 ? $"已创建提交 {hash}" : "已创建提交";
    }

    public static string SwitchBranch(JsonElement args)
    {
        var root = Root(args);
        var branch = Str(args, "branch").Trim();
        if (branch.Length == 0) throw new ToolHostException("E_GIT_INPUT", "缺少有效参数：branch");
        if (!IsSafeBranchName(branch)) throw new ToolHostException("E_GIT_INPUT", "分支名称不合法");
        var create = BoolArg(args, "create") || Str(args, "create") == "true";
        var gitArgs = create ? new[] { "checkout", "-b", branch } : new[] { "checkout", branch };
        var result = RunGit(args, root, Concat(BaseConfig(args), gitArgs));
        if (result.ExitCode != 0) throw GitFailed("git checkout", result);
        return $"已切换到分支 {branch}";
    }

    public static string Push(JsonElement args)
    {
        var root = Root(args);
        string remote;
        if (HasProperty(args, "remote"))
        {
            remote = Str(args, "remote").Trim();
            if (remote.Length == 0) throw new ToolHostException("E_GIT_INPUT", "缺少有效参数：remote");
        }
        else
        {
            remote = "origin";
        }
        if (!Regex.IsMatch(remote, "^[A-Za-z0-9._-]+$"))
            throw new ToolHostException("E_GIT_INPUT", "远端名称不合法");

        var status = RunStatusSummary(args, root);
        var branch = status.Current ?? "HEAD";
        var setUpstream = string.IsNullOrEmpty(status.Tracking) && branch != "HEAD";
        var gitArgs = setUpstream
            ? new[] { "push", "--set-upstream", remote, branch, "--verbose", "--porcelain" }
            : new[] { "push", remote, "--verbose", "--porcelain" };
        var result = RunGit(args, root, Concat(BaseConfig(args), gitArgs));
        if (result.ExitCode != 0) throw GitFailed("git push", result);
        return setUpstream ? $"已推送到 {remote}/{branch} 并建立跟踪关系" : $"已推送到 {remote}";
    }

    public static string Revert(JsonElement args)
    {
        var root = Root(args);
        var commit = Str(args, "commit").Trim();
        if (!Regex.IsMatch(commit, "^[0-9a-f]{7,40}$", RegexOptions.IgnoreCase))
            throw new ToolHostException("E_GIT_INPUT", "提交标识必须是 7 到 40 位十六进制 hash");
        var result = RunGit(args, root, Concat(BaseConfig(args), new[] { "revert", "--no-edit", commit }));
        if (result.ExitCode != 0) throw GitFailed("git revert", result);
        return $"已创建回退提交 {commit}";
    }

    public static string Diff(JsonElement args)
    {
        var root = Root(args);
        string gitRef;
        if (HasProperty(args, "ref"))
        {
            gitRef = Str(args, "ref").Trim();
            if (gitRef.Length == 0) throw new ToolHostException("E_GIT_INPUT", "缺少有效参数：ref");
        }
        else
        {
            gitRef = "HEAD";
        }
        if (!IsSafeGitRef(gitRef)) throw new ToolHostException("E_GIT_INPUT", "ref 不合法");
        var staged = BoolArg(args, "staged") || Str(args, "staged") == "true";
        var paths = StringArray(args, "paths");
        if (paths.Any(p => !IsSafeRelativePath(p)))
            throw new ToolHostException("E_GIT_INPUT", "请提供仓库内相对路径");
        // TS：Number(args.maxPatchLines) ?? 400 —— 非数字字符串得到 NaN → 不截断（保持 NaN 语义）
        var maxPatchLines = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("maxPatchLines", out _)
            ? Num(args, "maxPatchLines")
            : 400;

        var diffArgs = new List<string>();
        if (staged) diffArgs.Add("--cached");
        diffArgs.Add(gitRef);
        if (paths.Count > 0) { diffArgs.Add("--"); diffArgs.AddRange(paths); }

        var summaryResult = RunGit(args, root, Concat(BaseConfig(args), new[] { "diff", "--stat=4096" }, diffArgs));
        var patchResult = RunGit(args, root, Concat(BaseConfig(args), new[] { "diff" }, diffArgs));
        var failed = summaryResult.ExitCode != 0 || patchResult.ExitCode != 0;
        if (failed && IsBadRevision(summaryResult) || failed && IsBadRevision(patchResult))
            return DiffJson(gitRef, staged, null, "", maxPatchLines);
        if (failed) throw GitFailed("git diff", summaryResult.ExitCode != 0 ? summaryResult : patchResult);

        var summary = ParseDiffStat(summaryResult.Stdout);
        var patch = patchResult.Stdout;
        return DiffJson(gitRef, staged, summary, patch, maxPatchLines);
    }

    public static string Log(JsonElement args)
    {
        var root = Root(args);
        var gitRef = "";
        if (HasProperty(args, "ref"))
        {
            gitRef = Str(args, "ref").Trim();
            if (gitRef.Length == 0) throw new ToolHostException("E_GIT_INPUT", "缺少有效参数：ref");
            if (!IsSafeGitRef(gitRef)) throw new ToolHostException("E_GIT_INPUT", "ref 不合法");
        }
        var logPath = "";
        if (HasProperty(args, "path"))
        {
            logPath = Str(args, "path").Trim();
            if (logPath.Length == 0) throw new ToolHostException("E_GIT_INPUT", "缺少有效参数：path");
            if (!IsSafeRelativePath(logPath)) throw new ToolHostException("E_GIT_INPUT", "请提供仓库内相对路径");
        }
        var maxCount = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("maxCount", out _)
            ? Num(args, "maxCount")
            : 20;
        if (double.IsNaN(maxCount) || double.IsInfinity(maxCount) || maxCount < 1 || maxCount > 200 || maxCount != Math.Floor(maxCount))
            throw new ToolHostException("E_GIT_INPUT", "maxCount 必须是 1 到 200 的整数");

        var logArgs = new List<string>
        {
            "log", "--pretty=format:%H\u001f%ad\u001f%an\u001f%s\u001e", "--date=short", $"-n{(int)maxCount}",
        };
        if (gitRef.Length > 0) logArgs.Add(gitRef);
        if (logPath.Length > 0) { logArgs.Add("--"); logArgs.Add(logPath); }
        var result = RunGit(args, root, Concat(BaseConfig(args), logArgs));
        if (result.ExitCode != 0) throw GitFailed("git log", result);

        var entries = new List<Dictionary<string, object?>>();
        foreach (var rawEntry in result.Stdout.Split('\u001e'))
        {
            var entry = rawEntry.StartsWith('\n') ? rawEntry[1..] : rawEntry;
            if (entry.Trim().Length == 0) continue;
            var fields = entry.Split('\u001f');
            entries.Add(new Dictionary<string, object?>
            {
                ["hash"] = fields.Length > 0 ? fields[0] : "",
                ["date"] = fields.Length > 1 ? fields[1] : "",
                ["author"] = fields.Length > 2 ? fields[2] : "",
                ["message"] = fields.Length > 3 ? fields[3] : "",
            });
        }
        return Serialize(entries);
    }

    // ── diff 输出与 evidence ─────────────────────────────────

    private static string DiffJson(string gitRef, bool staged, StatResult? summary, string patch, double maxPatchLines)
    {
        var lines = patch.Split('\n');
        var truncated = lines.Length > maxPatchLines;
        var patchOut = truncated
            ? string.Join("\n", lines.Take((int)maxPatchLines)) + "\n...（已截断）"
            : patch;
        var perFile = (summary?.Files ?? new List<StatFile>())
            .Where(f => f.HasStats)
            .Select(f => new Dictionary<string, object?>
            {
                ["file"] = f.File, ["insertions"] = f.Insertions, ["deletions"] = f.Deletions,
            })
            .ToList();

        // evidence：按 "diff --git" 分段，逐文件挂 parseUnifiedPatch 结果（与 TS 工具同构；
        // 注意 TS 用的是截断后的 patch，截断时证据行同样只含截断部分）
        var segmentByFile = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var segment in Regex.Split(patchOut, @"(?=^diff --git )", RegexOptions.Multiline))
        {
            if (!segment.StartsWith("diff --git", StringComparison.Ordinal)) continue;
            var m = Regex.Match(segment, @"^diff --git a/(.+?) b/", RegexOptions.Multiline);
            if (m.Success) segmentByFile[m.Groups[1].Value] = segment;
        }
        var changes = new List<Dictionary<string, object?>>();
        foreach (var pf in perFile)
        {
            var file = (string)pf["file"]!;
            var change = new Dictionary<string, object?>
            {
                ["file"] = file,
                ["kind"] = "modified",
                ["insertions"] = pf["insertions"],
                ["deletions"] = pf["deletions"],
            };
            if (segmentByFile.TryGetValue(file, out var segment))
                change["diff"] = ParseUnifiedPatch(segment);
            changes.Add(change);
        }
        ToolEvidence.Finalize(changes);

        var output = new Dictionary<string, object?>
        {
            ["base"] = gitRef,
            ["staged"] = staged,
            ["files"] = perFile.Select(f => f["file"]).ToList(),
            ["insertions"] = summary?.Insertions ?? 0,
            ["deletions"] = summary?.Deletions ?? 0,
            ["truncated"] = truncated,
            ["patch"] = patchOut,
            ["perFile"] = perFile,
            ["changes"] = changes,
        };
        return Serialize(output);
    }

    /// <summary>unified patch → diff 行（tool-evidence.ts parseUnifiedPatch 同构）。</summary>
    private static List<object> ParseUnifiedPatch(string patch)
    {
        var lines = new List<object>();
        foreach (var raw in patch.Split('\n'))
        {
            if (raw.StartsWith("@@", StringComparison.Ordinal))
                lines.Add(new Dictionary<string, object?> { ["type"] = "hunk", ["text"] = raw });
            else if (raw.StartsWith("+++", StringComparison.Ordinal) || raw.StartsWith("---", StringComparison.Ordinal)
                || raw.StartsWith("diff ", StringComparison.Ordinal) || raw.StartsWith("index ", StringComparison.Ordinal))
                continue;
            else if (raw.StartsWith('+'))
                lines.Add(new Dictionary<string, object?> { ["type"] = "add", ["text"] = ToolEvidence.ClipLine(raw[1..]) });
            else if (raw.StartsWith('-'))
                lines.Add(new Dictionary<string, object?> { ["type"] = "remove", ["text"] = ToolEvidence.ClipLine(raw[1..]) });
            else
                lines.Add(new Dictionary<string, object?> { ["type"] = "context", ["text"] = ToolEvidence.ClipLine(raw.Length > 0 ? raw[1..] : "") });
        }
        return lines;
    }

    // ── status 解析（simple-git StatusSummary 同构）────────────

    private sealed class StatusFile
    {
        public string Path = "";
        public string? FromPath;
        public char Index;
        public char WorkingDir;
    }

    private sealed class StatusSummary
    {
        public int Ahead;
        public int Behind;
        public string? Current;
        public string? Tracking;
        public readonly List<StatusFile> Files = new();
        public readonly List<string> Conflicted = new();
    }

    private static readonly HashSet<string> ConflictCodes = new(StringComparer.Ordinal)
    {
        "AA", "DD", "AU", "UA", "DU", "UD", "UU",
    };

    private static readonly Regex AheadRe = new(@"ahead (\d+)", RegexOptions.Compiled);
    private static readonly Regex BehindRe = new(@"behind (\d+)", RegexOptions.Compiled);
    private static readonly Regex CurrentRe = new(@"^(.+?(?=\.\.\.|\s|$))", RegexOptions.Compiled);
    private static readonly Regex TrackingRe = new(@"\.\.\.(\S*)", RegexOptions.Compiled);
    private static readonly Regex OnEmptyBranchRe = new(@"\son\s(\S+?)(?=\.\.\.|$)", RegexOptions.Compiled);

    private static StatusSummary RunStatusSummary(JsonElement args, string root)
    {
        var result = RunGit(args, root, Concat(BaseConfig(args), new[] { "status", "--porcelain", "-b", "-u", "--null" }));
        if (result.ExitCode != 0) throw GitFailed("git status", result);

        var summary = new StatusSummary();
        var tokens = result.Stdout.Split('\0');
        for (var i = 0; i < tokens.Length; i++)
        {
            var line = tokens[i].Trim();
            if (line.Length == 0) continue;
            if (line[0] == 'R' && i + 1 < tokens.Length) line += "\0" + tokens[++i];
            SplitStatusLine(summary, line);
        }
        return summary;
    }

    private static void SplitStatusLine(StatusSummary result, string lineStr)
    {
        var t = lineStr.Trim();
        if (t.Length >= 3 && t[2] == ' ') Data(result, t[0], t[1], t[3..]);
        else if (t.Length >= 2 && t[1] == ' ') Data(result, ' ', t[0], t[2..]);
    }

    private static void Data(StatusSummary result, char index, char workingDir, string path)
    {
        var raw = $"{index}{workingDir}";
        if (raw == "##") { ParseBranchHeader(result, path); return; }
        if (raw == "!!") return;
        if (ConflictCodes.Contains(raw)) result.Conflicted.Add(path);

        var file = new StatusFile { Path = path, Index = index, WorkingDir = workingDir };
        if (index == 'R' || workingDir == 'R')
        {
            var sep = path.IndexOf('\0');
            if (sep > 0 && sep < path.Length - 1)
            {
                file.Path = path[..sep];
                file.FromPath = path[(sep + 1)..];
            }
            else
            {
                file.FromPath = path; // 与 simple-git fromPathRegex 未命中的兜底一致
            }
        }
        result.Files.Add(file);
    }

    private static void ParseBranchHeader(StatusSummary result, string line)
    {
        var ahead = AheadRe.Match(line);
        result.Ahead = ahead.Success && int.TryParse(ahead.Groups[1].Value, out var a) ? a : 0;
        var behind = BehindRe.Match(line);
        result.Behind = behind.Success && int.TryParse(behind.Groups[1].Value, out var b) ? b : 0;

        var current = CurrentRe.Match(line);
        result.Current = current.Success ? current.Groups[1].Value : null;
        var tracking = TrackingRe.Match(line);
        result.Tracking = tracking.Success ? tracking.Groups[1].Value : null;
        var onEmpty = OnEmptyBranchRe.Match(line);
        if (onEmpty.Success) result.Current = onEmpty.Groups[1].Value;
    }

    private static readonly Regex DetachedBranchRe = new(
        @"^([*+]\s)?\((?:HEAD )?detached (?:from|at) (\S+)\)\s+([a-z0-9]+)\s(.*)$", RegexOptions.Compiled);
    private static readonly Regex GenericBranchRe = new(
        @"^([*+]\s)?(\S+)\s+([a-z0-9]+)\s?(.*)$", RegexOptions.Compiled | RegexOptions.Singleline);

    private static List<string> RunBranches(JsonElement args, string root)
    {
        var result = RunGit(args, root, Concat(BaseConfig(args), new[] { "branch", "-v" }));
        if (result.ExitCode != 0) throw GitFailed("git branch", result);
        var all = new List<string>();
        foreach (var rawLine in result.Stdout.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0) continue;
            var detached = DetachedBranchRe.Match(line);
            if (detached.Success) { all.Add(detached.Groups[2].Value); continue; }
            var generic = GenericBranchRe.Match(line);
            if (generic.Success) all.Add(generic.Groups[2].Value);
        }
        return all;
    }

    // ── 行数统计（simple-git diffSummary + untracked numstat 同构）──

    private static (int, int, Dictionary<string, (int, int)>) LineStats(JsonElement args, string root, List<StatusFile> files)
    {
        var insertions = 0;
        var deletions = 0;
        var byPath = new Dictionary<string, (int, int)>(StringComparer.Ordinal);

        StatResult? tracked = null;
        try
        {
            var result = RunGit(args, root, Concat(BaseConfig(args), new[] { "diff", "--stat=4096", "HEAD" }));
            if (result.ExitCode == 0) tracked = ParseDiffStat(result.Stdout);
        }
        catch (ToolHostException) { /* 与 TS .catch(zeros) 一致 */ }
        if (tracked is not null)
        {
            insertions = tracked.Insertions;
            deletions = tracked.Deletions;
            foreach (var f in tracked.Files)
                if (f.HasStats) byPath[f.File] = (f.Insertions, f.Deletions);
        }

        foreach (var file in files.Where(f => f.Index == '?' || f.WorkingDir == '?'))
        {
            GitResult result;
            try
            {
                result = RunGit(args, root, Concat(BaseConfig(args),
                    new[] { "diff", "--no-index", "--numstat", "--", "/dev/null", file.Path }));
            }
            catch (ToolHostException) { continue; } // 与 TS spawn 失败跳过一致

            var added = 0;
            var removed = 0;
            if (!string.IsNullOrWhiteSpace(result.Stdout))
            {
                var tokens = result.Stdout.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
                if (tokens.Length >= 2)
                {
                    added = Regex.IsMatch(tokens[0], @"^\d+$") ? int.Parse(tokens[0]) : 0;
                    removed = Regex.IsMatch(tokens[1], @"^\d+$") ? int.Parse(tokens[1]) : 0;
                }
            }
            insertions += added;
            deletions += removed;
            byPath[file.Path] = (added, removed);
        }
        return (insertions, deletions, byPath);
    }

    // ── diff --stat 解析（simple-git statParser 同构）──────────

    private sealed class StatFile
    {
        public string File = "";
        public int Insertions;
        public int Deletions;
        public bool HasStats;
    }

    private sealed class StatResult
    {
        public int Insertions;
        public int Deletions;
        public int Changed;
        public readonly List<StatFile> Files = new();
    }

    private static readonly Regex StatFileRe = new(@"^(.+)\s+\|\s+(\d+)(\s+[+\-]+)?$", RegexOptions.Compiled);
    private static readonly Regex StatBinaryRe = new(@"^(.+) \|\s+Bin ([0-9.]+) -> ([0-9.]+) ([a-z]+)", RegexOptions.Compiled);
    private static readonly Regex StatSummaryRe = new(@"(\d+) files? changed\s*((?:, \d+ [^,]+){0,2})", RegexOptions.Compiled);
    private static readonly Regex StatInsertedRe = new(@"(\d+) i", RegexOptions.Compiled);
    private static readonly Regex StatDeletedRe = new(@"(\d+) d", RegexOptions.Compiled);

    private static StatResult ParseDiffStat(string stdout)
    {
        var result = new StatResult();
        foreach (var line in stdout.Split('\n'))
        {
            var fileMatch = StatFileRe.Match(line);
            if (fileMatch.Success)
            {
                var alterations = fileMatch.Groups[3].Value;
                var file = fileMatch.Groups[1].Value.Trim();
                var insertions = alterations.Count(c => c == '+');
                var deletions = alterations.Count(c => c == '-');
                result.Files.Add(new StatFile { File = file, Insertions = insertions, Deletions = deletions, HasStats = true });
                continue;
            }
            if (StatBinaryRe.IsMatch(line))
            {
                var binary = StatBinaryRe.Match(line);
                result.Files.Add(new StatFile { File = binary.Groups[1].Value.Trim() });
                continue;
            }
            var summary = StatSummaryRe.Match(line);
            if (summary.Success)
            {
                result.Changed = int.TryParse(summary.Groups[1].Value, out var changed) ? changed : 0;
                var ins = StatInsertedRe.Match(summary.Groups[2].Value);
                var del = StatDeletedRe.Match(summary.Groups[2].Value);
                result.Insertions = ins.Success ? int.Parse(ins.Groups[1].Value) : 0;
                result.Deletions = del.Success ? int.Parse(del.Groups[1].Value) : 0;
            }
        }
        return result;
    }

    // ── 基础命令 ─────────────────────────────────────────────

    private sealed record GitResult(int ExitCode, string Stdout, string Stderr);

    private static GitResult RunGit(JsonElement args, string cwd, List<string> gitArgs)
    {
        var command = Str(args, "__gitCommand");
        if (command.Length == 0)
            throw new ToolHostException("E_GIT_NO_COMMAND", "缺少 __gitCommand（git 可执行路径），git 工具需经宿主包装器调用");

        var psi = new ProcessStartInfo(command)
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in gitArgs) psi.ArgumentList.Add(a);
        if (BoolArg(args, "__gitIsolated"))
        {
            psi.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
            psi.Environment["GIT_CONFIG_GLOBAL"] = "NUL";
        }

        using var proc = Process.Start(psi)
            ?? throw new ToolHostException("E_GIT_SPAWN", "git 进程启动失败");
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        if (!proc.WaitForExit(CommandTimeoutMs))
        {
            // TODO(后续): 宿主被杀（取消/崩溃）时 git 子进程可能孤儿化——entireProcessTree
            // 只覆盖本进程主动超时路径；如需彻底清理可引入 Windows Job Object（设计稿 §2 已记）
            try { proc.Kill(entireProcessTree: true); } catch { /* ignore */ }
            throw new ToolHostException("E_GIT_TIMEOUT", "git 命令超时（120s）");
        }
        return new GitResult(proc.ExitCode, stdoutTask.GetAwaiter().GetResult(), stderrTask.GetAwaiter().GetResult());
    }

    private static bool IsRepository(JsonElement args, string root)
    {
        try
        {
            var result = RunGit(args, root, Concat(BaseConfig(args), new[] { "rev-parse", "--is-inside-work-tree" }));
            return result.ExitCode == 0 && result.Stdout.Trim() == "true";
        }
        catch (ToolHostException)
        {
            return false;
        }
    }

    /// <summary>与 TS buildGitBaseConfig 同构：safe.directory 两种写法 +（仅 commit）身份配置。</summary>
    private static List<string> BaseConfig(JsonElement args, GitIdentityInfo? identity = null)
    {
        var root = Root(args);
        var config = new List<string>
        {
            "-c", $"safe.directory={root}",
            "-c", $"safe.directory={root.Replace('\\', '/')}",
        };
        if (identity is not null)
        {
            var name = Regex.Replace(identity.Name, "[\r\n]", " ").Trim();
            var email = Regex.Replace(identity.Email, "[\r\n]", "").Trim();
            if (name.Length > 0) { config.Add("-c"); config.Add($"user.name={name}"); }
            if (email.Length > 0) { config.Add("-c"); config.Add($"user.email={email}"); }
        }
        return config;
    }

    private static string ClassifyKind(StatusFile file, bool conflicted)
    {
        var code = $"{file.Index}{file.WorkingDir}";
        if (conflicted || code.Contains('U')) return "conflicted";
        if (code.Contains('?')) return "added";
        if (code.Contains('R') || file.FromPath is not null) return "renamed";
        if (code.Contains('D')) return "deleted";
        if (code.Contains('A')) return "added";
        return "modified";
    }

    private static bool IsBadRevision(GitResult result)
        => Regex.IsMatch(result.Stderr + result.Stdout, "unknown revision|bad revision|ambiguous argument", RegexOptions.IgnoreCase);

    private static ToolHostException GitFailed(string name, GitResult result)
        => new("E_GIT_FAILED", $"{name} 失败（exit {result.ExitCode}）: {result.Stderr.Trim()}");

    // ── 输入校验（git-service.ts 同构）────────────────────────

    private static bool IsSafeRelativePath(string value)
    {
        if (value.Length == 0 || Path.IsPathRooted(value) || value.Contains('\0')) return false;
        return !value.Replace('\\', '/').Split('/').Any(part => part == "..");
    }

    private static bool IsSafeBranchName(string value)
        => value.Length > 0 && value.Length <= 255 && !value.StartsWith('-')
            && !value.Contains("..")
            && !Regex.IsMatch(value, @"[~^:\\?*\[\s]")
            && !value.EndsWith('/')
            && !value.EndsWith('.');

    private static bool IsSafeGitRef(string value)
        => Regex.IsMatch(value, "^[0-9a-fA-F]{7,40}$")
            || (Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$")
                && !value.Contains("..") && !value.Contains("@{") && !value.EndsWith('.'));

    // ── JSON 与参数 ──────────────────────────────────────────

    private sealed record GitIdentityInfo(string Name, string Email);

    private static GitIdentityInfo? GitIdentity(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("__gitIdentity", out var id)
            || id.ValueKind != JsonValueKind.Object) return null;
        var name = id.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()! : "";
        var email = id.TryGetProperty("email", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString()! : "";
        return new GitIdentityInfo(name, email);
    }

    private static string Root(JsonElement args)
    {
        var root = Str(args, "__cyreneRoot");
        if (string.IsNullOrWhiteSpace(root))
            throw new ToolHostException("E_GIT_NO_ROOT", "缺少 __cyreneRoot（工作区根），git 工具需经宿主包装器调用");
        return root;
    }

    /// <summary>与 TS stringArrayArg 同构：属性缺省返回空；存在时必须是全部为非空字符串的数组。</summary>
    private static List<string> StringArray(JsonElement args, string key)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(key, out var el))
            return new List<string>();
        if (el.ValueKind != JsonValueKind.Array)
            throw new ToolHostException("E_GIT_INPUT", $"缺少有效参数：{key}");
        var list = new List<string>();
        foreach (var item in el.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
                throw new ToolHostException("E_GIT_INPUT", $"缺少有效参数：{key}");
            var value = item.GetString()!.Trim();
            if (value.Length == 0)
                throw new ToolHostException("E_GIT_INPUT", $"缺少有效参数：{key}");
            list.Add(value);
        }
        return list;
    }

    private static string Str(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()!
            : "";

    private static bool BoolArg(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.True;

    private static bool HasProperty(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out _);

    private static double Num(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var el) ? HostLocale.Num(el) : double.NaN;

    private static List<string> Concat(List<string> head, IEnumerable<string> tail)
    {
        var list = new List<string>(head);
        list.AddRange(tail);
        return list;
    }

    private static List<string> Concat(List<string> head, IEnumerable<string> middle, IEnumerable<string> tail)
    {
        var list = new List<string>(head);
        list.AddRange(middle);
        list.AddRange(tail);
        return list;
    }

    private static string Serialize(object value) => JsonSerializer.Serialize(value, Json);

    private static string EmptyStatusJson(string sessionId, string state, string message)
        => Serialize(new Dictionary<string, object?>
        {
            ["sessionId"] = sessionId,
            ["state"] = state,
            ["message"] = message,
            ["executable"] = null,
            ["branch"] = null,
            ["files"] = new List<object>(),
            ["summary"] = new Dictionary<string, int>
            {
                ["added"] = 0, ["modified"] = 0, ["deleted"] = 0, ["renamed"] = 0, ["conflicted"] = 0,
            },
            ["lines"] = new Dictionary<string, int> { ["insertions"] = 0, ["deletions"] = 0 },
            ["ahead"] = 0,
            ["behind"] = 0,
        });
}
