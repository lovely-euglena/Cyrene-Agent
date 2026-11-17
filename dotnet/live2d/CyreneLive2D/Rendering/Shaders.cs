// HLSL 着色器（运行时 D3DCompile 编译，无离线编译链）。
//
// 语义权威参考：CubismNativeFramework 的 legacy（≤5.2）渲染路径
// （Rendering/OpenGL/Shaders/Standard/*.frag 与 D3D11/Shaders/CubismEffect.fx），
// 与 pixi-live2d-display 0.5.0-beta 的 WebGL 路径逐 feature 对照（issue #257 T2）：
//   - 纹理预乘 alpha（CPU 上传时预乘），Normal=ONE/INV_SRC_ALPHA；
//   - Add=ONE/ONE（alpha 保持 dst）；Multiply=DST_COLOR/INV_SRC_ALPHA；
//   - multiply/screen 色：rgb*multiply + screen*a - rgb*screen（预乘分支）；
//   - 蒙版：缓冲清 1，setup 以 ZERO/ONE_MINUS_SRC_COLOR 写入 channelFlag*a，
//     masked 采样 (1-mask)*channelFlag 求和乘到颜色（inverted 取反）。
//
// 与 Framework 的两处有意偏差（像素等价，文档见 docs/design/2026-11-17-live2d-dotnet-sidecar.md）：
//   1. 蒙版缓冲：每个唯一蒙版组一张全尺寸 RT（R 通道），不做 RGBA×9 宫格打包——
//      省掉 layout 矩阵链，正确性相同（打包只是性能优化）。
//   2. UV 不翻转：PNG 按行序（顶行在前）上传，Cubism UV 原点即左上——D3D 天然一致
//      （Framework 的 1-uv 翻转是其 GL 遗留纹理上传约定，D3D11 样例同策）。
//   3. Cubism 5 Core 无 culling API——全部按双面绘制（csmIsDoubleSided 语义）。

namespace CyreneLive2D.Rendering;

internal static class Shaders
{
    // 常量缓冲布局（VS/PS 共用 b0）：
    //   float4x4 mvp        offset 0
    //   float4 baseColor    offset 64   (1,1,1,opacity)
    //   float4 multiply     offset 80
    //   float4 screen       offset 96
    //   float4 channelFlag  offset 112  蒙版通道选择（本实现恒为 (1,0,0,0)）
    public const int ConstantBufferSize = 128;

    public const string VertexSource = """
        cbuffer Constants : register(b0)
        {
            float4x4 mvp;
            float4 baseColor;
            float4 multiplyColor;
            float4 screenColor;
            float4 channelFlag;
        };

        struct VS_IN
        {
            float2 pos : POSITION;
            float2 uv  : TEXCOORD0;
        };

        struct VS_OUT
        {
            float4 pos      : SV_Position;
            float2 uv       : TEXCOORD0;
            float4 clipPos  : TEXCOORD1;
        };

        VS_OUT VSMain(VS_IN In)
        {
            VS_OUT Out;
            Out.pos = mul(float4(In.pos, 0.0f, 1.0f), mvp);
            Out.clipPos = Out.pos;
            Out.uv = In.uv;
            return Out;
        }
        """;

    /// <summary>普通 drawable（预乘 alpha；multiply/screen；baseColor.a=不透明度）。</summary>
    public const string PixelNormalSource = """
        cbuffer Constants : register(b0)
        {
            float4x4 mvp;
            float4 baseColor;
            float4 multiplyColor;
            float4 screenColor;
            float4 channelFlag;
        };

        Texture2D mainTexture : register(t0);
        SamplerState mainSampler : register(s0);

        struct VS_OUT
        {
            float4 pos      : SV_Position;
            float2 uv       : TEXCOORD0;
            float4 clipPos  : TEXCOORD1;
        };

        float4 PSMain(VS_OUT In) : SV_Target
        {
            float4 texColor = mainTexture.Sample(mainSampler, In.uv);
            texColor.rgb = texColor.rgb * multiplyColor.rgb;
            texColor.rgb = (texColor.rgb + screenColor.rgb * texColor.a) - (texColor.rgb * screenColor.rgb);
            return texColor * baseColor;
        }
        """;

    /// <summary>
    /// 蒙版生成：写入 channelFlag * 纹理alpha。混合态 ZERO/ONE_MINUS_SRC_COLOR
    /// 在清 1 的缓冲上得到「蒙版区域=1-alpha」。全缓冲即单一蒙版区域，无需 isInside。
    /// </summary>
    public const string PixelSetupMaskSource = """
        cbuffer Constants : register(b0)
        {
            float4x4 mvp;
            float4 baseColor;
            float4 multiplyColor;
            float4 screenColor;
            float4 channelFlag;
        };

        Texture2D mainTexture : register(t0);
        SamplerState mainSampler : register(s0);

        struct VS_OUT
        {
            float4 pos      : SV_Position;
            float2 uv       : TEXCOORD0;
            float4 clipPos  : TEXCOORD1;
        };

        float4 PSMain(VS_OUT In) : SV_Target
        {
            return channelFlag * mainTexture.Sample(mainSampler, In.uv).a;
        }
        """;

    /// <summary>
    /// 带蒙版 drawable。maskUv 由 NDC 换算（顶行原点）：(ndc*0.5+0.5, 0.5-ndc.y*0.5)。
    /// inverted=1 时取反（csmIsInvertedMask）。
    /// </summary>
    public const string PixelMaskedSource = """
        cbuffer Constants : register(b0)
        {
            float4x4 mvp;
            float4 baseColor;
            float4 multiplyColor;
            float4 screenColor;
            float4 channelFlag;
        };

        Texture2D mainTexture : register(t0);
        Texture2D maskTexture : register(t1);
        SamplerState mainSampler : register(s0);

        struct VS_OUT
        {
            float4 pos      : SV_Position;
            float2 uv       : TEXCOORD0;
            float4 clipPos  : TEXCOORD1;
        };

        float4 PSMain(VS_OUT In) : SV_Target
        {
            float4 texColor = mainTexture.Sample(mainSampler, In.uv);
            texColor.rgb = texColor.rgb * multiplyColor.rgb;
            texColor.rgb = (texColor.rgb + screenColor.rgb * texColor.a) - (texColor.rgb * screenColor.rgb);
            float4 color = texColor * baseColor;

            float2 ndc = In.clipPos.xy / In.clipPos.w;
            float2 maskUv = float2(ndc.x * 0.5f + 0.5f, 0.5f - ndc.y * 0.5f);
            float4 clipMask = (1.0f - maskTexture.Sample(mainSampler, maskUv)) * channelFlag;
            float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
            return color * maskVal;
        }
        """;

    public const string PixelMaskedInvertedSource = """
        cbuffer Constants : register(b0)
        {
            float4x4 mvp;
            float4 baseColor;
            float4 multiplyColor;
            float4 screenColor;
            float4 channelFlag;
        };

        Texture2D mainTexture : register(t0);
        Texture2D maskTexture : register(t1);
        SamplerState mainSampler : register(s0);

        struct VS_OUT
        {
            float4 pos      : SV_Position;
            float2 uv       : TEXCOORD0;
            float4 clipPos  : TEXCOORD1;
        };

        float4 PSMain(VS_OUT In) : SV_Target
        {
            float4 texColor = mainTexture.Sample(mainSampler, In.uv);
            texColor.rgb = texColor.rgb * multiplyColor.rgb;
            texColor.rgb = (texColor.rgb + screenColor.rgb * texColor.a) - (texColor.rgb * screenColor.rgb);
            float4 color = texColor * baseColor;

            float2 ndc = In.clipPos.xy / In.clipPos.w;
            float2 maskUv = float2(ndc.x * 0.5f + 0.5f, 0.5f - ndc.y * 0.5f);
            float4 clipMask = (1.0f - maskTexture.Sample(mainSampler, maskUv)) * channelFlag;
            float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
            return color * (1.0f - maskVal);
        }
        """;

    /// <summary>
    /// 嵌套蒙版：蒙版 drawable 自身也被蒙版时的 setup 变体
    /// （channelFlag * alpha * maskVal）。混合态仍为 ZERO/ONE_MINUS_SRC_COLOR。
    /// </summary>
    public const string PixelSetupMaskMaskedSource = """
        cbuffer Constants : register(b0)
        {
            float4x4 mvp;
            float4 baseColor;
            float4 multiplyColor;
            float4 screenColor;
            float4 channelFlag;
        };

        Texture2D mainTexture : register(t0);
        Texture2D maskTexture : register(t1);
        SamplerState mainSampler : register(s0);

        struct VS_OUT
        {
            float4 pos      : SV_Position;
            float2 uv       : TEXCOORD0;
            float4 clipPos  : TEXCOORD1;
        };

        float4 PSMain(VS_OUT In) : SV_Target
        {
            float2 ndc = In.clipPos.xy / In.clipPos.w;
            float2 maskUv = float2(ndc.x * 0.5f + 0.5f, 0.5f - ndc.y * 0.5f);
            float4 clipMask = (1.0f - maskTexture.Sample(mainSampler, maskUv)) * channelFlag;
            float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
            return channelFlag * mainTexture.Sample(mainSampler, In.uv).a * maskVal;
        }
        """;
}
