// 表情播放编排（T3）——逐式移植 pld ExpressionManager.ts + Cubism4ExpressionManager.ts。
// 表情走与动作相同的队列机制（入场淡出旧表情）。defaultExpression=空表情（reset 用）；
// currentExpression 不被 reset 覆盖，restore 时恢复。同步磁盘加载（sidecar 无网络异步）。

using CyreneLive2D.Model;

namespace CyreneLive2D.Motion;

public sealed class ExpressionManager
{
    private readonly List<(string Name, string File)> _definitions;
    private readonly string _modelDir;
    private readonly Expression3?[] _expressions;
    private readonly HashSet<int> _failed = new();
    private readonly MotionQueueManager _queue = new();
    private int _reserveExpressionIndex = -1;

    public Expression3 DefaultExpression { get; }
    public Expression3 CurrentExpression { get; private set; }

    public ExpressionManager(Model3Json manifest, string modelDir)
    {
        _definitions = manifest.Expressions.Select(kv => (kv.Key, kv.Value)).ToList();
        _modelDir = modelDir;
        _expressions = new Expression3?[_definitions.Count];
        DefaultExpression = Expression3.CreateEmpty();
        CurrentExpression = DefaultExpression;
        StopAllExpressions();
    }

    public int DefinitionCount => _definitions.Count;
    public bool IsFinished() => _queue.IsFinished();

    public int GetExpressionIndex(string name) => _definitions.FindIndex(d => d.Name == name);

    private Expression3? LoadExpression(int index)
    {
        if (index < 0 || index >= _definitions.Count) return null;
        if (_failed.Contains(index)) return null;
        if (_expressions[index] != null) return _expressions[index];
        try
        {
            var path = Path.Combine(_modelDir, _definitions[index].File);
            var expr = Expression3.Load(path);
            _expressions[index] = expr;
            return expr;
        }
        catch
        {
            _failed.Add(index);
            return null;
        }
    }

    private int IndexOfCurrent()
    {
        for (int i = 0; i < _expressions.Length; i++)
        {
            if (ReferenceEquals(_expressions[i], CurrentExpression)) return i;
        }
        return -1; // DefaultExpression 不在缓存里
    }

    public bool SetExpression(string name) => SetExpression(GetExpressionIndex(name));

    public bool SetExpression(int index)
    {
        if (!(index > -1 && index < _definitions.Count)) return false;
        if (index == IndexOfCurrent()) return false;

        _reserveExpressionIndex = index;
        var expression = LoadExpression(index);
        if (expression == null || _reserveExpressionIndex != index) return false;

        _reserveExpressionIndex = -1;
        CurrentExpression = expression;
        SetExpressionInternal(expression);
        return true;
    }

    public bool SetRandomExpression()
    {
        if (_definitions.Count == 0) return false;
        var available = new List<int>();
        for (int i = 0; i < _definitions.Count; i++)
        {
            if (!_failed.Contains(i) && !ReferenceEquals(_expressions[i], CurrentExpression) && i != _reserveExpressionIndex)
            {
                available.Add(i);
            }
        }
        if (available.Count == 0) return false;
        return SetExpression(available[Random.Shared.Next(available.Count)]);
    }

    public void ResetExpression() => SetExpressionInternal(DefaultExpression);
    public void RestoreExpression() => SetExpressionInternal(CurrentExpression);

    public bool Update(CubismModel model, float nowSeconds)
        => !IsFinished() && _queue.DoUpdateMotion(model, nowSeconds);

    public void StopAllExpressions() => _queue.StopAllMotions();

    private void SetExpressionInternal(Expression3 expression) => _queue.StartMotion(expression);
}