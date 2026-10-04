// PDF 文本提取探针（测试专用，仅 smoke-host）：配合工具矩阵校验 write_pdf 的文本内容。
// 用法：dotnet cyrene-smoke.dll --pdf-text <file.pdf>  → stdout 输出提取文本（逐页）
using UglyToad.PdfPig;

namespace CyreneSmoke;

internal static class PdfTextProbe
{
    public static int Run(string path)
    {
        try
        {
            using var doc = PdfDocument.Open(path);
            foreach (var page in doc.GetPages())
            {
                Console.Out.Write(page.Text);
                Console.Out.Write('\n');
            }
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("pdf-text 失败: " + ex.Message);
            return 1;
        }
    }
}
