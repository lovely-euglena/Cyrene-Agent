// HLSL 着色器（运行时 D3DCompile 编译，无离线编译链）。
//
// 语义权威参考：pixi-live2d-display 0.5.0-beta 的 WebGL 路径（issue #257 T2），
// 逐 feature 对照 cubism4.es.js（CubismRenderer_WebGL / CubismClippingManager_WebGL）：
//   - 纹理预乘 alpha（CPU 上传时预乘，pixi alphaMode 默认 UNPACK），Normal=ONE/INV_SRC_ALPHA；
//   - Add=ONE/ONE（alpha 保持 dst）；Multiply=DST_COLOR/INV_SRC_ALPHA；
//   - multiply/screen 色：rgb*multiply + screen*a - rgb*screen（预乘分支）；
//   - 蒙版：256×256 RGBA 图集（pld 默认 maskBufferCount=1、_useHighPrecisionMask=false），
//     组按 setupLayoutBounds 网格布局 + RGBA 通道打包；缓冲清 (1,1,1,1)，
//     setup 以 ZERO/ONE_MINUS_SRC_COLOR 写入 channelFlag*alpha*isInside；
//     masked 采样 (1-mask)*channelFlag 求和乘到颜色（inverted 取反）。
//
// 与 web 轨的 D3D11 适配偏差（像素等价，推导见 docs/design/2026-11-17-live2d-dotnet-sidecar.md）：
//   1. UV 的 V 翻转：Cubism Core 的 drawable UV 原点在左下（GL 约定），而 D3D11
//      纹理顶行序上传（v=0=顶行），故 VS 内 uv.y=1-uv.y。经沙箱真渲染验证。
//   2. 蒙版图集行序：GL framebuffer 行 0=底、D3D11 RT 行 0=顶，故 masked PS 采样
//      蒙版图集时 maskUv.y=1-clipPos.y/w（setup 绘制用同一 y-up clip 矩阵，净效果一致）。
//   3. Cubism 5 Core 无 culling API——全部按双面绘制（csmIsDoubleSided 语义）。

namespace CyreneLive2D.Rendering;

internal static class Shaders
{
    // 常量缓冲布局（VS/PS 共用 b0，行主序）：
    //   float4x4 mvp         offset 0    主变换 / 蒙版 setup 时为 matrixForMask
    //   float4 baseColor     offset 64   (1,1,1,opacity)；setup 时为单元格 clip 边界
    //   float4 multiply      offset 80
    //   float4 screen        offset 96
    //   float4 channelFlag   offset 112  蒙版通道选择（R/G/B/A 之一）
    //   float4x4 maskMatrix  offset 128  matrixForDraw（模型坐标→蒙版图集 [0,1]）
    public const int ConstantBufferSize = 192;

    // 矩阵必须显式 row_major：CPU 侧按行主序上传（mul(行向量, M)，平移在第 4 行
    // [12]/[13]）。HLSL 默认列主序打包会把 maskMatrix 读错——clipPos 退化为模型
    // 坐标，蒙版 isInside 全 0、虹膜被裁掉（T6 实测：缺 row_major 时 diff 0.55%，
    // 加上后 0.0065%）。mvp 为对角缩放看似不受影响，maskMatrix 含平移则暴露。
    private const string CBuffer = """
        cbuffer Constants : register(b0)
        {
            row_major float4x4 mvp;
            float4 baseColor;
            float4 multiplyColor;
            float4 screenColor;
            float4 channelFlag;
            row_major float4x4 maskMatrix;
        };
        """;

    private const string VsOut = """
        struct VS_OUT
        {
            float4 pos      : SV_Position;
            float2 uv       : TEXCOORD0;
            float4 clipPos  : TEXCOORD1;
        };
        """;

    public const string VertexSource = CBuffer + """

        struct VS_IN
        {
            float2 pos : POSITION;
            float2 uv  : TEXCOORD0;
        };
        """ + VsOut + """

        VS_OUT VSMain(VS_IN In)
        {
            VS_OUT Out;
            Out.pos = mul(float4(In.pos, 0.0f, 1.0f), mvp);
            Out.clipPos = mul(float4(In.pos, 0.0f, 1.0f), maskMatrix);
            Out.uv = float2(In.uv.x, 1.0f - In.uv.y);
            return Out;
        }
        """;

    /// <summary>普通 drawable（预乘 alpha；multiply/screen；baseColor.a=不透明度）。</summary>
    public const string PixelNormalSource = CBuffer + """

        Texture2D mainTexture : register(t0);
        SamplerState mainSampler : register(s0);
        """ + VsOut + """

        float4 PSMain(VS_OUT In) : SV_Target
        {
            float4 texColor = mainTexture.Sample(mainSampler, In.uv);
            texColor.rgb = texColor.rgb * multiplyColor.rgb;
            texColor.rgb = (texColor.rgb + screenColor.rgb * texColor.a) - (texColor.rgb * screenColor.rgb);
            return texColor * baseColor;
        }
        """;

    /// <summary>
    /// 蒙版生成（pld fragmentShaderSrcsetupMask 同式）：
    /// channelFlag * 纹理alpha * isInside；isInside 用 baseColor 存的单元格 clip 边界
    /// 做 step 裁剪（共享图集时防止跨单元格串扰）。混合态 ZERO/ONE_MINUS_SRC_COLOR
    /// 在清 1 的缓冲上得到「蒙版区域=1-alpha」。
    /// </summary>
    public const string PixelSetupMaskSource = CBuffer + """

        Texture2D mainTexture : register(t0);
        SamplerState mainSampler : register(s0);
        """ + VsOut + """

        float4 PSMain(VS_OUT In) : SV_Target
        {
            float2 p = In.clipPos.xy / In.clipPos.w;
            float isInside =
                step(baseColor.x, p.x) * step(baseColor.y, p.y) *
                step(p.x, baseColor.z) * step(p.y, baseColor.w);
            return channelFlag * mainTexture.Sample(mainSampler, In.uv).a * isInside;
        }
        """;

    /// <summary>
    /// 带蒙版 drawable（pld fragmentShaderSrcMaskPremultipliedAlpha 同式）。
    /// clipPos = matrixForDraw * 顶点（图集 [0,1]）；D3D11 行序适配翻 y。
    /// </summary>
    public const string PixelMaskedSource = CBuffer + """

        Texture2D mainTexture : register(t0);
        Texture2D maskTexture : register(t1);
        SamplerState mainSampler : register(s0);
        """ + VsOut + """

        float4 PSMain(VS_OUT In) : SV_Target
        {
            float4 texColor = mainTexture.Sample(mainSampler, In.uv);
            texColor.rgb = texColor.rgb * multiplyColor.rgb;
            texColor.rgb = (texColor.rgb + screenColor.rgb * texColor.a) - (texColor.rgb * screenColor.rgb);
            float4 color = texColor * baseColor;

            float2 maskUv = float2(In.clipPos.x / In.clipPos.w, 1.0f - In.clipPos.y / In.clipPos.w);
            float4 clipMask = (1.0f - maskTexture.Sample(mainSampler, maskUv)) * channelFlag;
            float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
            return color * maskVal;
        }
        """;

    public const string PixelMaskedInvertedSource = CBuffer + """

        Texture2D mainTexture : register(t0);
        Texture2D maskTexture : register(t1);
        SamplerState mainSampler : register(s0);
        """ + VsOut + """

        float4 PSMain(VS_OUT In) : SV_Target
        {
            float4 texColor = mainTexture.Sample(mainSampler, In.uv);
            texColor.rgb = texColor.rgb * multiplyColor.rgb;
            texColor.rgb = (texColor.rgb + screenColor.rgb * texColor.a) - (texColor.rgb * screenColor.rgb);
            float4 color = texColor * baseColor;

            float2 maskUv = float2(In.clipPos.x / In.clipPos.w, 1.0f - In.clipPos.y / In.clipPos.w);
            float4 clipMask = (1.0f - maskTexture.Sample(mainSampler, maskUv)) * channelFlag;
            float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
            return color * (1.0f - maskVal);
        }
        """;
}