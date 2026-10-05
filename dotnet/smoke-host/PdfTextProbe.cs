// PDF 文本提取探针（测试专用，仅 smoke-host）：配合工具矩阵校验 write_pdf 的文本内容。
// 用法：dotnet cyrene-smoke.dll --pdf-text <file.pdf>  → stdout 输出提取文本（逐页）
using System.Text;
using UglyToad.PdfPig;

namespace CyreneSmoke;

internal static class PdfTextProbe
{
    public static int Run(string path)
    {
        try
        {
            using var doc = PdfDocument.Open(path);
            // 显式 UTF-8 输出：默认 Console 编码随 Windows 代码页（中文机为 GBK），
            // 矩阵按 UTF-8 解码会把 CJK 读成 U+FFFD（本地矩阵假失败）。
            using var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            foreach (var page in doc.GetPages())
            {
                stdout.Write(page.Text);
                stdout.Write('\n');
            }
            stdout.Flush();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("pdf-text 失败: " + ex.Message);
            return 1;
        }
    }
}
