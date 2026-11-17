// pose3.json 部件姿态切换（T3）——逐式移植 Framework CubismPose.cpp。
// 每组部件互斥显示：参数值 > Epsilon 的部件为「可见」，其不透明度按 dt/FadeIn 上升，
// 其余部件按双直线公式（Phi=0.5 交点）+ 背景透出阈值 0.15 衰减。Link 部件同步不透明度。
// 首次对某模型更新时 Reset：组内第一个部件显示（参数/不透明度=1），其余=0。
// Cyrene 模型无 pose3.json——引擎侧 Pose 为 null 时本层不参与帧循环；实现供通用模型与自测。

using System.Text.Json;
using CyreneLive2D.Model;

namespace CyreneLive2D.Motion;

public sealed unsafe class Pose3
{
    private const float Epsilon = 0.001f;
    private const float DefaultFadeInSeconds = 0.5f;
    private const float Phi = 0.5f;
    private const float BackOpacityThreshold = 0.15f;

    private sealed class PartData
    {
        public string PartId = "";
        public int ParameterIndex;
        public int PartIndex;
        public List<PartData> Link = new();

        public void Initialize(CubismModel model)
        {
            ParameterIndex = model.GetParameterIndex(PartId);
            PartIndex = model.GetPartIndex(PartId);
            if (ParameterIndex >= 0) model.SetParameterValueByIndex(ParameterIndex, 1);
        }
    }

    private readonly List<PartData> _partGroups = new();
    private readonly List<int> _partGroupCounts = new();
    private float _fadeTimeSeconds = DefaultFadeInSeconds;
    private CubismModel? _lastModel;

    public float FadeTimeSeconds => _fadeTimeSeconds;
    public int GroupCount => _partGroupCounts.Count;

    public static Pose3 Load(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return Create(doc.RootElement);
    }

    public static Pose3 Create(JsonElement root)
    {
        var pose = new Pose3();

        if (root.TryGetProperty("FadeInTime", out var fadeEl) && fadeEl.ValueKind == JsonValueKind.Number)
        {
            pose._fadeTimeSeconds = (float)fadeEl.GetDouble();
            if (pose._fadeTimeSeconds < 0.0f) pose._fadeTimeSeconds = DefaultFadeInSeconds;
        }

        if (root.TryGetProperty("Groups", out var groups) && groups.ValueKind == JsonValueKind.Array)
        {
            foreach (var group in groups.EnumerateArray())
            {
                int groupCount = 0;
                foreach (var partInfo in group.EnumerateArray())
                {
                    var partData = new PartData
                    {
                        PartId = partInfo.GetProperty("Id").GetString() ?? "",
                    };
                    if (partInfo.TryGetProperty("Link", out var linkList) && linkList.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var linkId in linkList.EnumerateArray())
                        {
                            partData.Link.Add(new PartData { PartId = linkId.GetString() ?? "" });
                        }
                    }
                    pose._partGroups.Add(partData);
                    groupCount++;
                }
                pose._partGroupCounts.Add(groupCount);
            }
        }

        return pose;
    }

    /// <summary>组内首部件显示、其余隐藏；Link 部件参数初始化为 1。</summary>
    public void Reset(CubismModel model)
    {
        int beginIndex = 0;
        foreach (var groupCount in _partGroupCounts)
        {
            for (int j = beginIndex; j < beginIndex + groupCount; j++)
            {
                var part = _partGroups[j];
                part.Initialize(model);

                if (part.PartIndex < 0) continue;

                float opacity = j == beginIndex ? 1.0f : 0.0f;
                model.PartOpacities[part.PartIndex] = opacity;
                if (part.ParameterIndex >= 0) model.SetParameterValueByIndex(part.ParameterIndex, opacity);

                foreach (var link in part.Link) link.Initialize(model);
            }
            beginIndex += groupCount;
        }
    }

    public void UpdateParameters(CubismModel model, float deltaTimeSeconds)
    {
        // 模型实例变化 → 重新初始化索引与状态
        if (!ReferenceEquals(model, _lastModel))
        {
            Reset(model);
        }
        _lastModel = model;

        if (deltaTimeSeconds < 0.0f) deltaTimeSeconds = 0.0f;

        int beginIndex = 0;
        foreach (var groupCount in _partGroupCounts)
        {
            DoFade(model, deltaTimeSeconds, beginIndex, groupCount);
            beginIndex += groupCount;
        }

        CopyPartOpacities(model);
    }

    private void DoFade(CubismModel model, float deltaTimeSeconds, int beginIndex, int partGroupCount)
    {
        int visiblePartIndex = -1;
        float newOpacity = 1.0f;

        // 找当前可见部件（参数值 > Epsilon）
        for (int i = beginIndex; i < beginIndex + partGroupCount; i++)
        {
            var part = _partGroups[i];
            if (part.ParameterIndex < 0) continue;

            if (model.GetParameterValue(part.ParameterIndex) > Epsilon)
            {
                if (visiblePartIndex >= 0) break;

                visiblePartIndex = i;
                if (_fadeTimeSeconds == 0.0f)
                {
                    newOpacity = 1.0f;
                    continue;
                }

                newOpacity = part.PartIndex >= 0 ? model.PartOpacities[part.PartIndex] : 0f;
                newOpacity += deltaTimeSeconds / _fadeTimeSeconds;
                if (newOpacity > 1.0f) newOpacity = 1.0f;
            }
        }

        if (visiblePartIndex < 0)
        {
            visiblePartIndex = 0;
            newOpacity = 1.0f;
        }

        // 可见部件升不透明度；其余按双直线 + 背景阈值衰减
        for (int i = beginIndex; i < beginIndex + partGroupCount; i++)
        {
            var part = _partGroups[i];
            if (part.PartIndex < 0) continue;

            if (visiblePartIndex == i)
            {
                model.PartOpacities[part.PartIndex] = newOpacity;
            }
            else
            {
                float opacity = model.PartOpacities[part.PartIndex];
                float a1 = ComputeHiddenOpacity(newOpacity);
                if (opacity > a1) opacity = a1;
                model.PartOpacities[part.PartIndex] = opacity;
            }
        }
    }

    /// <summary>
    /// 隐藏部件目标不透明度（纯函数，供自测）：双直线过 (0,1)/(Phi,Phi)/(1,0)，
    /// 背景透出 (1-a1)*(1-newOpacity) 超过 0.15 时抬高 a1 限制。
    /// </summary>
    internal static float ComputeHiddenOpacity(float newOpacity)
    {
        float a1 = newOpacity < Phi
            ? newOpacity * (Phi - 1) / Phi + 1.0f        // 过 (0,1),(Phi,Phi)
            : (1 - newOpacity) * Phi / (1.0f - Phi);     // 过 (1,0),(Phi,Phi)

        float backOpacity = (1.0f - a1) * (1.0f - newOpacity);
        if (backOpacity > BackOpacityThreshold)
        {
            a1 = 1.0f - BackOpacityThreshold / (1.0f - newOpacity);
        }
        return a1;
    }

    private void CopyPartOpacities(CubismModel model)
    {
        foreach (var part in _partGroups)
        {
            if (part.Link.Count == 0 || part.PartIndex < 0) continue;

            float opacity = model.PartOpacities[part.PartIndex];
            foreach (var link in part.Link)
            {
                if (link.PartIndex < 0) continue;
                model.PartOpacities[link.PartIndex] = opacity;
            }
        }
    }
}