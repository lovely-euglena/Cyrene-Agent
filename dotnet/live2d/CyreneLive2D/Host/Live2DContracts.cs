// Live2D 侧车协议契约（C# 侧唯一来源；TS 镜像见
// src/main/live2d/live2d-host-protocol.ts，契约测试锁定两侧一致）。
//
// 请求（Electron → 侧车）：
//   load            {modelPath, dataDir?}                加载模型（含 Core 解析/下载）
//   show / hide                                          窗口显隐
//   setBounds       {x,y,width,height}                   DIP 坐标（主进程窗口语义）
//   setZoom         {zoom}                               0.5–2
//   setAlwaysOnTop  {value}
//   play            {target:{kind:"motion",group,motionName}|{kind:"expression",name}}
//   speechPrepare                                        说话前：表情回正+停口型+停秋千
//   mouthStart      {durationMs}                         假口型（与 web 轨同语义）
//   mouthStop
//   setDragging     {value}                              拖拽中（暂停渲染节拍/点击穿透）
//   setInteractive  {value}                              手动覆盖点击穿透（托盘拖拽模式）
//   pause / resume                                       渲染生命周期（隐藏时停帧）
//   hitTest         {x,y}                                诊断：窗口坐标命中区域
//   captureFrame                                         PNG base64（拖拽快照/T6 对照）
//   getDiagnostics                                       资源/帧率/控制器状态
//   setParameter    {id,value}                           诊断/测试：直写参数
//   renderOnce                                           诊断/测试：立即渲一帧
//   tick            {dtMs}                               诊断/测试：确定性推进一帧（T6 对照）
//   shutdown
//
// 事件（侧车 → Electron）：
//   ready / loaded {model} / loadFailed {error,errorCode}
//   hit {areas:[...], x, y} / miss {area}
//   interactive {value}                                  点击穿透状态翻转
//   dragStart / dragMove {screenX,screenY} / dragEnd     拖拽（主进程落位）
//   frameStats {fps, frameMs}                            低频统计（诊断）

namespace CyreneLive2D.Host;

public static class Live2DOps
{
    // 请求
    public const string Load = "load";
    public const string Show = "show";
    public const string Hide = "hide";
    public const string SetBounds = "setBounds";
    public const string SetZoom = "setZoom";
    public const string SetAlwaysOnTop = "setAlwaysOnTop";
    public const string Play = "play";
    public const string SpeechPrepare = "speechPrepare";
    public const string MouthStart = "mouthStart";
    public const string MouthStop = "mouthStop";
    public const string SetDragging = "setDragging";
    public const string SetInteractive = "setInteractive";
    public const string Pause = "pause";
    public const string Resume = "resume";
    public const string HitTest = "hitTest";
    public const string CaptureFrame = "captureFrame";
    public const string GetDiagnostics = "getDiagnostics";
    public const string SetParameter = "setParameter";
    public const string RenderOnce = "renderOnce";
    public const string Tick = "tick";
    public const string Shutdown = "shutdown";

    // 事件
    public const string Ready = "ready";
    public const string Loaded = "loaded";
    public const string LoadFailed = "loadFailed";
    public const string Hit = "hit";
    public const string Miss = "miss";
    public const string Interactive = "interactive";
    public const string DragStart = "dragStart";
    public const string DragMove = "dragMove";
    public const string DragEnd = "dragEnd";
    public const string FrameStats = "frameStats";
}

public static class Live2DErrors
{
    public const string CoreMissing = "E_CORE_MISSING";
    public const string CoreDownload = "E_CORE_DOWNLOAD";
    public const string ModelLoad = "E_MODEL_LOAD";
    public const string NotLoaded = "E_NOT_LOADED";
    public const string BadArgs = "E_BAD_ARGS";
    public const string Render = "E_RENDER";
    public const string Window = "E_WINDOW";
    public const string Internal = "E_INTERNAL";
}
