using System.IO;

namespace CyreneNative.Storage;

/// <summary>
/// 云存储协议统一操作面。所有方法在 StorageSessionManager 的档案串行区内同步执行
/// （调用方在 Task.Run 线程上），relPath 一律为「档案根相对路径」（"" = 根）。
/// 完整性/覆盖策略（overwrite 预检、本地文件原子落盘）由宿主层统一处理。
/// </summary>
internal interface IStorageProvider : IDisposable
{
    bool IsConnected { get; }

    void Connect();

    /// <summary>返回 null = 不存在。</summary>
    StorageEntry? Stat(string relPath);

    /// <summary>列目录（maxEntries 截断）。relPath 必须是目录。</summary>
    List<StorageEntry> List(string relPath, int maxEntries, out bool truncated);

    Stream OpenRead(string relPath);

    void Put(string relPath, Stream source, long length, bool createParents);

    void Download(string relPath, Stream destination);

    void Delete(string relPath, bool recursive);

    void Mkdir(string relPath, bool recursive);

    void Move(string fromRel, string toRel, bool overwrite);

    void Copy(string fromRel, string toRel, bool overwrite);

    /// <summary>连通性自检，返回耗时 ms；失败抛 StorageException。</summary>
    long Test();
}
