namespace CyreneEmbedSidecar;

/// <summary>
/// 按模型目录（modelDir）为键的引擎池：惰性加载、容量上限、LRU 卸载、租约保护。
///
/// 设计约束（issue IKIH28，内存/线程安全优先）：
///   - 纯逻辑类：引擎类型泛型 + 加载工厂注入，自检（verify-models）用假引擎
///     覆盖路由/LRU/上限/默认回退，不依赖任何模型文件。
///   - 线程安全：池簿记用单一 _lock，Acquire / Release / Dispose 串行。
///   - 加载在锁内执行：并发请求同一新目录只加载一次，避免两份大 session
///     同时驻留后被卸载（内存峰值翻倍）；代价是加载期间其他 Acquire 短暂
///     阻塞（模型加载秒级且罕见，可接受）。
///   - 引擎内推理串行由各引擎自身的锁保证（EmbeddingEngine._runLock）；
///     不同引擎可并行推理。选择「各自锁」而非全局单锁：两种模型同时活跃的
///     概率低，且 IntraOpNumThreads 已限流，全局锁只会让慢模型阻塞快模型；
///     池只负责生命周期安全（绝不 Dispose 正在推理的引擎）。
///   - 租约：Acquire 返回 PooledEngine，Dispose 时释放。租约持有期间（如
///     doc-import 分钟级任务）不会被 LRU 卸载，防止 Dispose 正在 Run 的
///     InferenceSession。若超限时所有引擎都被租用，允许短暂超出 capacity，
///     待任一租约释放后立即回落；因此稳态数量 ≤ capacity。
/// </summary>
public sealed class EnginePool<T> : IDisposable where T : class, IDisposable
{
    private sealed class Entry
    {
        public required T Engine { get; init; }
        public long LastUsed { get; set; }
        public int Leases { get; set; }
    }

    private readonly object _lock = new();
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly Func<string, T> _factory;
    private long _useStamp;
    private bool _disposed;

    public EnginePool(int capacity, Func<string, T> factory)
    {
        if (capacity < 1) throw new ArgumentOutOfRangeException(nameof(capacity), "capacity must be >= 1");
        Capacity = capacity;
        _factory = factory ?? throw new ArgumentNullException(nameof(factory));
    }

    /// <summary>池容量上限（稳态最多驻留的引擎数）。</summary>
    public int Capacity { get; }

    /// <summary>当前驻留引擎数（诊断/自检用；租约占满时瞬时可能 &gt; Capacity，见类注释）。</summary>
    public int Count
    {
        get { lock (_lock) return _entries.Count; }
    }

    public bool ContainsKey(string key)
    {
        lock (_lock) return _entries.ContainsKey(key);
    }

    /// <summary>当前驻留键的快照（诊断用）。</summary>
    public string[] Keys
    {
        get { lock (_lock) return _entries.Keys.ToArray(); }
    }

    /// <summary>
    /// 取引擎（未命中则调用工厂加载）。返回租约，调用方必须 Dispose 释放；
    /// 租约持有期间该引擎不会被 LRU 卸载。
    /// </summary>
    public PooledEngine Acquire(string key)
    {
        lock (_lock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!_entries.TryGetValue(key, out var entry))
            {
                entry = new Entry { Engine = _factory(key) };
                _entries[key] = entry;
            }
            entry.Leases++;
            entry.LastUsed = ++_useStamp;
            TrimLocked();
            return new PooledEngine(this, key, entry.Engine);
        }
    }

    private void Release(string key, T engine)
    {
        lock (_lock)
        {
            if (_entries.TryGetValue(key, out var entry) && ReferenceEquals(entry.Engine, engine))
            {
                if (entry.Leases > 0) entry.Leases--;
                TrimLocked();
            }
        }
    }

    /// <summary>超限时卸载最久未使用且无租约的引擎（卸载 = Dispose）。</summary>
    private void TrimLocked()
    {
        while (_entries.Count > Capacity)
        {
            string? victimKey = null;
            var oldest = long.MaxValue;
            foreach (var (key, entry) in _entries)
            {
                if (entry.Leases == 0 && entry.LastUsed < oldest)
                {
                    oldest = entry.LastUsed;
                    victimKey = key;
                }
            }
            if (victimKey is null) return; // 全部被租用：允许短暂超限，Release 时再收
            var victim = _entries[victimKey];
            _entries.Remove(victimKey);
            victim.Engine.Dispose();
        }
    }

    /// <summary>
    /// 卸载全部引擎（进程收尾用）。假定调用时无进行中的推理；池内引擎无论
    /// 是否被租用都会被 Dispose，之后 Acquire 抛 ObjectDisposedException，
    /// 迟到的 Release 安全 no-op。
    /// </summary>
    public void Dispose()
    {
        List<T> engines;
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
            engines = _entries.Values.Select((e) => e.Engine).ToList();
            _entries.Clear();
        }
        foreach (var engine in engines) engine.Dispose();
    }

    /// <summary>引擎租约：Dispose 释放；重复 Dispose 安全（幂等）。</summary>
    public sealed class PooledEngine : IDisposable
    {
        private EnginePool<T>? _pool;
        private readonly string _key;

        public T Engine { get; }

        internal PooledEngine(EnginePool<T> pool, string key, T engine)
        {
            _pool = pool;
            _key = key;
            Engine = engine;
        }

        public void Dispose()
        {
            var pool = Interlocked.Exchange(ref _pool, null);
            pool?.Release(_key, Engine);
        }
    }
}
