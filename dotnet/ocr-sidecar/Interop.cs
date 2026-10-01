using System.Runtime.InteropServices;

namespace CyreneOcr;

/// <summary>
/// 访问 WinRT SoftwareBitmap 像素缓冲。
///
/// CsWinRT 下无法把 <c>IMemoryBufferReference</c> 直接强转成 [ComImport] 接口
/// （会抛 "Invalid cast from 'WinRT.IInspectable'"），因此绕过投影层：
/// 取 <see cref="WinRT.IWinRTObject.NativeObject"/> 的 ThisPtr，手工 QI
/// IMemoryBufferByteAccess，再从 vtable 第 4 个槽调用 GetBuffer。
/// </summary>
internal static class BitmapPixels
{
    private static readonly Guid MemoryBufferByteAccessIid = new("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D");

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private unsafe delegate int GetBufferDelegate(IntPtr thisPtr, out byte* buffer, out uint capacity);

    /// <summary>返回像素缓冲首地址。指针在 <paramref name="memoryBufferReference"/> 存活期间有效。</summary>
    public static unsafe byte* GetBufferPointer(object memoryBufferReference, out uint capacity)
    {
        var thisPtr = ((WinRT.IWinRTObject)memoryBufferReference).NativeObject.ThisPtr;
        var iid = MemoryBufferByteAccessIid;
        var hr = Marshal.QueryInterface(thisPtr, in iid, out var byteAccess);
        if (hr != 0) throw new COMException("IMemoryBufferByteAccess 查询失败", hr);
        try
        {
            var vtable = Marshal.ReadIntPtr(byteAccess);
            var getBuffer = Marshal.GetDelegateForFunctionPointer<GetBufferDelegate>(
                Marshal.ReadIntPtr(vtable, IntPtr.Size * 3));
            int getHr = getBuffer(byteAccess, out var buffer, out var cap);
            if (getHr != 0) throw new COMException("IMemoryBufferByteAccess.GetBuffer 失败", getHr);
            capacity = cap;
            return buffer;
        }
        finally
        {
            Marshal.Release(byteAccess);
        }
    }
}
