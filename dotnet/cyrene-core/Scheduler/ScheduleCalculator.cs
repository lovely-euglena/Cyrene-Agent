using System.Globalization;
using System.Text.RegularExpressions;

namespace CyreneNative.Scheduler;

/// <summary>
/// 排期计算器：逐行对照 src/main/scheduler/schedule-calculator.ts。
///
/// 时间语义：DateTimeOffset + 本地时区墙钟（对齐 JS Date 的 getFullYear/setHours
/// 等本地字段操作）。monthly/yearly 短月「跳过不夹取」；interval 以
/// scheduledFireAt 为基线累加，避免触发漂移。
/// 已知边界（见交付报告）：DST 跳变时 .NET 与 V8 对「不存在/重复墙钟」的
/// 选取可能相差一小时；store 校验通过前不会走到非法组合。
/// </summary>
public static class ScheduleCalculator
{
    private static readonly Regex TimeOfDayRegex = new("^[0-9]{2}:[0-9]{2}$", RegexOptions.Compiled);

    /// <summary>由本地墙钟构造时间点（无效墙钟取标准时偏移，效果同 JS 前跳）。</summary>
    public static DateTimeOffset FromLocalWall(DateTime wall)
    {
        var unspecified = DateTime.SpecifyKind(wall, DateTimeKind.Unspecified);
        return new DateTimeOffset(unspecified, TimeZoneInfo.Local.GetUtcOffset(unspecified));
    }

    /// <summary>对齐 TS parseTimeOfDay：严格 HH:mm，范围 00:00-23:59。</summary>
    public static bool TryParseTimeOfDay(string? timeOfDay, out int hours, out int minutes)
    {
        hours = 0;
        minutes = 0;
        if (timeOfDay is null || !TimeOfDayRegex.IsMatch(timeOfDay)) return false;
        hours = int.Parse(timeOfDay.AsSpan(0, 2), CultureInfo.InvariantCulture);
        minutes = int.Parse(timeOfDay.AsSpan(3, 2), CultureInfo.InvariantCulture);
        return hours is >= 0 and <= 23 && minutes is >= 0 and <= 59;
    }

    private static DateTimeOffset? AtLocalTime(DateTimeOffset baseTime, string? timeOfDay)
    {
        if (!TryParseTimeOfDay(timeOfDay, out var hours, out var minutes)) return null;
        var wall = baseTime.LocalDateTime;
        var target = new DateTime(wall.Year, wall.Month, wall.Day, hours, minutes, 0, DateTimeKind.Unspecified);
        return FromLocalWall(target);
    }

    /// <summary>对齐 TS intervalMs：仅 "minutes" 特判，其余（含缺失）按小时。</summary>
    private static long IntervalMs(ScheduleConfig schedule)
    {
        var unitMs = schedule.Unit == IntervalUnit.Minutes ? 60_000L : 3_600_000L;
        return (long)(schedule.Every ?? 0) * unitMs;
    }

    public static DateTimeOffset? ComputeInitialNextFireAt(ScheduleConfig schedule, DateTimeOffset now)
    {
        switch (schedule.Kind)
        {
            case ScheduleKind.Once:
            {
                if (!SchedulerJson.TryParseIso(schedule.RunAt, out var runAt)) return null;
                return runAt > now ? runAt : null;
            }
            case ScheduleKind.Daily:
            {
                var today = AtLocalTime(now, schedule.TimeOfDay);
                if (today is null) return null;
                if (today > now) return today;
                return FromLocalWall(today.Value.LocalDateTime.AddDays(1));
            }
            case ScheduleKind.Weekdays:
            {
                var candidate = AtLocalTime(now, schedule.TimeOfDay);
                if (candidate is null) return null;
                for (var offset = 0; offset <= 7; offset += 1)
                {
                    var next = FromLocalWall(candidate.Value.LocalDateTime.AddDays(offset));
                    var dow = (int)next.DayOfWeek; // Sunday = 0，与 JS getDay 一致
                    if (dow != 0 && dow != 6 && next > now) return next;
                }
                return null;
            }
            case ScheduleKind.Weekly:
            {
                var candidate = AtLocalTime(now, schedule.TimeOfDay);
                if (candidate is null || schedule.DayOfWeek is not int dayOfWeek) return null;
                var daysAhead = ((dayOfWeek - (int)now.DayOfWeek) % 7 + 7) % 7;
                candidate = FromLocalWall(candidate.Value.LocalDateTime.AddDays(daysAhead));
                if (candidate > now) return candidate;
                return FromLocalWall(candidate.Value.LocalDateTime.AddDays(7));
            }
            case ScheduleKind.Monthly:
            {
                var candidate = AtLocalTime(now, schedule.TimeOfDay);
                if (candidate is null || schedule.DayOfMonth is not int dayOfMonth) return null;
                var hours = candidate.Value.LocalDateTime.Hour;
                var minutes = candidate.Value.LocalDateTime.Minute;
                var nowWall = now.LocalDateTime;
                for (var offset = 0; offset <= 1200; offset += 1)
                {
                    // new Date(y, m + offset, day, h, min)：day 溢出滚入下月，随后按月份相等性过滤（短月跳过不夹取）
                    var firstOfMonth = new DateTime(nowWall.Year, nowWall.Month, 1, hours, minutes, 0, DateTimeKind.Unspecified).AddMonths(offset);
                    var next = firstOfMonth.AddDays(dayOfMonth - 1);
                    var expectedMonth = ((nowWall.Month - 1 + offset) % 12 + 12) % 12;
                    if (next.Month - 1 != expectedMonth) continue;
                    var nextDto = FromLocalWall(next);
                    if (nextDto > now) return nextDto;
                }
                return null;
            }
            case ScheduleKind.Yearly:
            {
                var candidate = AtLocalTime(now, schedule.TimeOfDay);
                if (candidate is null || schedule.Month is not int month || schedule.DayOfMonth is not int dayOfMonth) return null;
                if (month is < 1 or > 12 || dayOfMonth is < 1 or > 31) return null;
                var hours = candidate.Value.LocalDateTime.Hour;
                var minutes = candidate.Value.LocalDateTime.Minute;
                for (var offset = 0; offset <= 400; offset += 1)
                {
                    var year = now.LocalDateTime.Year + offset;
                    var firstOfMonth = new DateTime(year, month, 1, hours, minutes, 0, DateTimeKind.Unspecified);
                    var next = firstOfMonth.AddDays(dayOfMonth - 1);
                    if (next.Year != year || next.Month != month || next.Day != dayOfMonth) continue;
                    var nextDto = FromLocalWall(next);
                    if (nextDto > now) return nextDto;
                }
                return null;
            }
            case ScheduleKind.Interval:
            {
                if (schedule.Every is not int every || every <= 0) return null;
                return now.AddMilliseconds(IntervalMs(schedule));
            }
            default:
                return null;
        }
    }

    public static DateTimeOffset? ComputeNextFireAtAfter(ScheduleConfig schedule, DateTimeOffset scheduledFireAt)
    {
        switch (schedule.Kind)
        {
            case ScheduleKind.Once:
                return null;
            case ScheduleKind.Daily:
                return FromLocalWall(scheduledFireAt.LocalDateTime.AddDays(1));
            case ScheduleKind.Weekdays:
            {
                var wall = scheduledFireAt.LocalDateTime;
                do { wall = wall.AddDays(1); }
                while (wall.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday);
                return FromLocalWall(wall);
            }
            case ScheduleKind.Weekly:
                return FromLocalWall(scheduledFireAt.LocalDateTime.AddDays(7));
            case ScheduleKind.Monthly:
            {
                if (schedule.DayOfMonth is not int dayOfMonth) return null;
                var wall = scheduledFireAt.LocalDateTime;
                var hours = wall.Hour;
                var minutes = wall.Minute;
                for (var offset = 1; offset <= 1200; offset += 1)
                {
                    var monthIndex = wall.Month - 1 + offset;
                    var firstOfMonth = new DateTime(wall.Year, 1, 1, hours, minutes, 0, DateTimeKind.Unspecified).AddMonths(monthIndex);
                    var next = firstOfMonth.AddDays(dayOfMonth - 1);
                    var expectedMonth = (monthIndex % 12 + 12) % 12;
                    if (next.Month - 1 == expectedMonth) return FromLocalWall(next);
                }
                return null;
            }
            case ScheduleKind.Yearly:
            {
                if (schedule.Month is not int month || schedule.DayOfMonth is not int dayOfMonth) return null;
                if (month is < 1 or > 12 || dayOfMonth is < 1 or > 31) return null;
                var wall = scheduledFireAt.LocalDateTime;
                var hours = wall.Hour;
                var minutes = wall.Minute;
                for (var offset = 1; offset <= 400; offset += 1)
                {
                    var year = wall.Year + offset;
                    var firstOfMonth = new DateTime(year, 1, 1, hours, minutes, 0, DateTimeKind.Unspecified).AddMonths(month - 1);
                    var next = firstOfMonth.AddDays(dayOfMonth - 1);
                    if (next.Year == year && next.Month == month && next.Day == dayOfMonth) return FromLocalWall(next);
                }
                return null;
            }
            case ScheduleKind.Interval:
            {
                if (schedule.Every is not int every || every <= 0) return null;
                return scheduledFireAt.AddMilliseconds(IntervalMs(schedule));
            }
            default:
                return null;
        }
    }

    public static DateTimeOffset? NormalizeOverdueNextFireAt(ScheduleConfig schedule, DateTimeOffset currentNextFireAt, DateTimeOffset now)
    {
        if (currentNextFireAt > now) return currentNextFireAt;
        if (schedule.Kind == ScheduleKind.Once) return null;
        if (schedule.Kind == ScheduleKind.Interval)
        {
            if (schedule.Every is not int every || every <= 0) return null;
            var step = IntervalMs(schedule);
            if (step <= 0) return null;
            var missed = (now.ToUnixTimeMilliseconds() - currentNextFireAt.ToUnixTimeMilliseconds()) / step + 1;
            return currentNextFireAt.AddMilliseconds(missed * step);
        }

        var cursor = currentNextFireAt;
        var guard = 0;
        while (cursor <= now && guard < 10_000)
        {
            var next = ComputeNextFireAtAfter(schedule, cursor);
            if (next is null) break;
            cursor = next.Value;
            guard += 1;
        }
        return cursor > now ? cursor : ComputeInitialNextFireAt(schedule, now);
    }
}
