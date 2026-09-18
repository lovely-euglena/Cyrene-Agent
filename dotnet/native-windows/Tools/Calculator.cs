using System.Text.Json;

namespace CyreneNative.Tools;

/// <summary>
/// calculator 的 .NET 实现——与 TS 版（utility-tools.ts）同语义：
/// 递归下降求值器，白名单函数表，零动态执行。
/// 语义对齐由 TS 侧测试双跑保证（同一断言集跑两轨）。
/// </summary>
internal static class Calculator
{
    private static readonly Dictionary<string, Func<double[], double>> Functions = new()
    {
        ["sqrt"] = a => Math.Sqrt(a[0]),
        ["abs"] = a => Math.Abs(a[0]),
        ["floor"] = a => Math.Floor(a[0]),
        ["ceil"] = a => Math.Ceiling(a[0]),
        ["round"] = a => Math.Round(a[0], MidpointRounding.AwayFromZero),
        ["min"] = a => a.Min(),
        ["max"] = a => a.Max(),
        ["ln"] = a => Math.Log(a[0]),
        ["log"] = a => Math.Log10(a[0]),
        ["log2"] = a => Math.Log2(a[0]),
        ["exp"] = a => Math.Exp(a[0]),
        ["sin"] = a => Math.Sin(a[0]),
        ["cos"] = a => Math.Cos(a[0]),
        ["tan"] = a => Math.Tan(a[0]),
    };

    private static readonly Dictionary<string, double> Constants = new()
    {
        ["pi"] = Math.PI,
        ["e"] = Math.E,
    };

    public static object Evaluate(JsonElement? args)
    {
        if (args is null || !args.Value.TryGetProperty("expression", out var exprEl))
            throw new InvalidOperationException("缺少 expression 参数");
        var src = exprEl.GetString();
        if (string.IsNullOrWhiteSpace(src))
            throw new InvalidOperationException("expression 不能为空");
        var value = Parse(src);
        return new { value, expression = src };
    }

    // ── tokenizer ──
    private enum Tok { Num, Op, Lp, Rp, Fn, Comma, Name }

    private sealed record Token(Tok Kind, string Text, double Num);

    private static List<Token> Tokenize(string src)
    {
        var tokens = new List<Token>();
        var i = 0;
        while (i < src.Length)
        {
            var c = src[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (char.IsDigit(c) || c == '.')
            {
                var j = i;
                while (j < src.Length && (char.IsDigit(src[j]) || src[j] == '.' || src[j] == '_')) j++;
                // 科学计数法
                if (j < src.Length && (src[j] == 'e' || src[j] == 'E'))
                {
                    var k = j + 1;
                    if (k < src.Length && (src[k] == '+' || src[k] == '-')) k++;
                    if (k < src.Length && char.IsDigit(src[k]))
                    {
                        while (k < src.Length && char.IsDigit(src[k])) k++;
                        j = k;
                    }
                }
                var text = src[i..j].Replace("_", "");
                if (!double.TryParse(text, out var num))
                    throw new InvalidOperationException($"非法数字: {text}");
                tokens.Add(new Token(Tok.Num, text, num));
                i = j;
                continue;
            }
            // 十六进制
            if (c == '0' && i + 1 < src.Length && (src[i + 1] == 'x' || src[i + 1] == 'X'))
            {
                var j = i + 2;
                while (j < src.Length && Uri.IsHexDigit(src[j])) j++;
                var text = src[i..j];
                if (!long.TryParse(text[2..], System.Globalization.NumberStyles.HexNumber, null, out var hex))
                    throw new InvalidOperationException($"非法十六进制: {text}");
                tokens.Add(new Token(Tok.Num, text, hex));
                i = j;
                continue;
            }
            if (c is '+' or '-' or '*' or '/' or '%' or '^')
            {
                tokens.Add(new Token(Tok.Op, c.ToString(), 0));
                i++;
                continue;
            }
            if (c == '(') { tokens.Add(new Token(Tok.Lp, "(", 0)); i++; continue; }
            if (c == ')') { tokens.Add(new Token(Tok.Rp, ")", 0)); i++; continue; }
            if (c == ',') { tokens.Add(new Token(Tok.Comma, ",", 0)); i++; continue; }
            if (char.IsLetter(c) || c == '_')
            {
                var j = i;
                while (j < src.Length && (char.IsLetterOrDigit(src[j]) || src[j] == '_')) j++;
                var name = src[i..j].ToLowerInvariant();
                if (Functions.ContainsKey(name)) tokens.Add(new Token(Tok.Fn, name, 0));
                else if (Constants.ContainsKey(name)) tokens.Add(new Token(Tok.Name, name, 0));
                else throw new InvalidOperationException($"未知标识符: {name}");
                i = j;
                continue;
            }
            throw new InvalidOperationException($"非法字符: {c}");
        }
        return tokens;
    }

    // ── parser ──
    private sealed class Parser(List<Token> tokens)
    {
        private readonly List<Token> _t = tokens;
        private int _pos;

        private Token? Peek() => _pos < _t.Count ? _t[_pos] : null;

        private Token Next()
        {
            var t = Peek() ?? throw new InvalidOperationException("表达式意外结束");
            _pos++;
            return t;
        }

        public double Parse()
        {
            var v = Expr();
            if (_pos < _t.Count) throw new InvalidOperationException("表达式结尾有多余内容");
            return v;
        }

        // expr := term (('+'|'-') term)*
        private double Expr()
        {
            var v = Term();
            while (Peek() is { Kind: Tok.Op } p && (p.Text == "+" || p.Text == "-"))
            {
                var op = Next().Text;
                var r = Term();
                v = op == "+" ? v + r : v - r;
            }
            return v;
        }

        // term := unary (('*'|'/'|'%') unary)*
        private double Term()
        {
            var v = Unary();
            while (Peek() is { Kind: Tok.Op } p && (p.Text == "*" || p.Text == "/" || p.Text == "%"))
            {
                var op = Next().Text;
                var r = Unary();
                if (op == "*") v = v * r;
                else if (r == 0) throw new InvalidOperationException("除数为零");
                else v = op == "/" ? v / r : v % r;
            }
            return v;
        }

        // unary := ('-'|'+') unary | power
        private double Unary()
        {
            if (Peek() is { Kind: Tok.Op } p && (p.Text == "-" || p.Text == "+"))
            {
                var op = Next().Text;
                var v = Unary();
                return op == "-" ? -v : v;
            }
            return Power();
        }

        // power := atom ('^' unary)?   （右结合）
        private double Power()
        {
            var v = Atom();
            if (Peek() is { Kind: Tok.Op } p && p.Text == "^")
            {
                Next();
                var r = Unary();
                return Math.Pow(v, r);
            }
            return v;
        }

        // atom := Num | Name | Fn '(' args ')' | '(' expr ')'
        private double Atom()
        {
            var t = Next();
            switch (t.Kind)
            {
                case Tok.Num:
                    return t.Num;
                case Tok.Name:
                    return Constants[t.Text];
                case Tok.Fn:
                {
                    if (Next().Kind != Tok.Lp) throw new InvalidOperationException("函数后必须跟左括号");
                    var args = new List<double>();
                    if (Peek() is { Kind: Tok.Rp })
                    {
                        Next();
                    }
                    else
                    {
                        args.Add(Expr());
                        while (Peek() is { Kind: Tok.Comma })
                        {
                            Next();
                            args.Add(Expr());
                        }
                        if (Next().Kind != Tok.Rp) throw new InvalidOperationException("缺少右括号");
                    }
                    return Functions[t.Text](args.ToArray());
                }
                case Tok.Lp:
                {
                    var v = Expr();
                    if (Next().Kind != Tok.Rp) throw new InvalidOperationException("缺少右括号");
                    return v;
                }
                default:
                    throw new InvalidOperationException($"意外的符号: {t.Text}");
            }
        }
    }

    internal static double Parse(string src) => new Parser(Tokenize(src)).Parse();
}
