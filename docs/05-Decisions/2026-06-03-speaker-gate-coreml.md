# 决策日志 — 2026-06-03 单麦声纹门控（CoreML drop-in）

> 关联 GitHub Issue #14「单麦回退完善：CoreML 声纹门控 + Swift VAD 轮次切分」

## 背景 / 为什么

双声道方案（麦克风=本人、系统音频 process-tap=发言人）依赖 system tap。当用户**不戴耳机或 tap 被拒**时只剩单麦，无法按音频**来源**区分两人，于是本人自说自话会触发误匹配——这正是产品要杜绝的「自问自答」。macOS **没有内置说话人识别 API**（SFSpeechRecognizer 不做 diarization，SoundAnalysis 只分类声音类型），所以引入一个本地 CoreML 说话人嵌入模型，按**说话人**给每个已定稿的 ASR 片段打标签，单麦回退时只让「发言人」片段进入匹配管线，恢复「本人语音永不触发匹配」的保证。

## 选型

- **模型**：CAM++ 中英文版（3D-Speaker / 达摩院 `iic/speech_campplus_sv_zh_en_16k-common_advanced`，~28MB，192 维嵌入，80 维 Kaldi fbank 输入，16kHz）。工具包 Apache-2.0、原生中英文。
- **最大风险 = 训练数据许可证**：VoxCeleb 训练权重是研究限定，商用有风险，污染 SpeechBrain/WeSpeaker/pyannote 的现成权重。CAM++ zh_en「advanced」号称非 VoxCeleb in-house 数据，但**上线前必须人工核实 ModelScope 的 license/训练数据字段**。转换脚本对此**硬性 gate**（无 `--i-have-verified-license` 拒绝下载）。
- **fbank 放在 Swift**（vDSP）而非烘进 CoreML 图：torchaudio 的 Kaldi fbank 分帧/加窗算子不易 trace 进 CoreML；可控的稳妥路径是文档化的 Swift 前端 + 接收 `[1,T,80]` fbank 的模型。

## 关键架构决策

1. **优雅退化是第一不变量**：模型文件 `resources/CAMPlusSpeaker.mlmodelc` **目前不存在**（drop-in，后续落地）。`CamPlusSpeakerGate` 在模型缺失/加载失败时 `model==nil ⇒ isEnrolled==false ⇒ label() 永不覆盖 role`，行为与旧的惰性 Stub **完全一致**——双声道路径**逐字节不变**。仅传 `--gate` 而无模型不改变任何行为。这让整套代码可在拿不到模型时安全合入并通过编译/单测。
2. **阈值语义**：录入的声纹是**本人**的。`label()`：cosine ≥ τ_high(0.70) ⇒ `.self`（本人）；≤ τ_low(0.55) ⇒ `.speaker`（他人）；中间 ⇒ `.unknown`（保留默认 role）。单麦门控时 mic 的 final 带 `role:speaker` ⇒ `routeSegment` 放行进入分类。τ 起点来自模型卡，需真机短片段标定。
3. **声纹传输/持久化**：Swift 经 stdout `{type:voiceprint,data:<base64 LE Float32>,dim}` 上报；主进程存 `appSettings`（key `speaker_voiceprint`，沿用 overlay_config 模式，无新表/迁移）；下次门控会话经 stdin `load-voiceprint` 恢复，免重录。
4. **门控激活点**：system tap 被拒的降级分支里，若已录入 + 模型存在 → 在 **mic 通道**武装门控（`--gate --model` 重启 + 恢复声纹）并推 `gate-status-changed:active`。
5. **路由契约修正**：`routeSegment(role,{systemAvailable,gating})` —— `speaker && (systemAvailable || gating==='active')` 才 classify，并在 interview-tab 中**真正调用**（原决策内联且单麦时永不分类，与门控目的冲突）。

## 落地范围（本轮，全部代码层 + 编译/单测验证）

- Swift：`AudioFeature.swift`（AVAudioConverter 重采样到 16k 单声道 + Kaldi 兼容 80 维 fbank，vDSP，`--dump-fbank` 自检）；`SpeakerGate.swift`（`CamPlusSpeakerGate` + 协议加 `beginEnrollment/loadVoiceprint/voiceprint`）；`SpeechHelper.swift`（`--model`、enroll-start/gate-finalize/load-voiceprint、voiceprint/enroll-progress 事件、segmentAudio 生命周期修复）；`package.json` build:swift 加文件。
- TS 主进程：`interview.ts`（门控/录入 6 个 invoke + 2 个 push、声纹持久化、模型解析、降级武装）；`speaker-gate-policy.ts`（纯函数 + 17 单测）。
- 渲染端：`turn-routing.ts`（+ 单测）、`interview-tab.tsx`（路由契约接入 + 状态/横幅/录入入口）、`enroll-voiceprint-modal.tsx`、`preload/index.ts` + `env.d.ts`。
- Python：`scripts/convert-campplus-coreml.py`（许可证 gate → ModelScope 下载 → trace → coremltools 转 mlprogram → `xcrun coremlc compile` 到 `.mlmodelc`；`--check-fbank` 离线数值对齐：余弦≥0.999 + max-abs 对数梅尔差 + 均值减后余弦）+ `README-speaker-model.md`。

**验证**：`build:swift` exit 0；`--dump-fbank` 1 秒信号 → 98 帧×80；`typecheck`/`eslint` 干净；`vitest` 166 全过。**无法在本机验证的**：CoreML 转换（需 coremltools+权重）、fbank 与模型训练前端的真值对齐（需 torch 离线跑 `--check-fbank`）、真机短片段阈值标定。

## 经过对抗式多维 review（7 维度 → 每个发现独立 skeptic 验证），已修复

- **[高] 监听器误删**：录入 modal 卸载时 `offGateStatus()=removeAllListeners` 会连带删掉 tab 的 gate-status 订阅，模型上线后会让门控状态在渲染端"静默失活"。→ modal 不再订阅该共享 channel；完成态改由权威的 `enroll-finalize` 结果驱动。
- **[中] enroll-finalize 竞态**：原先同步返回后立即读 `getGateStatus()`，在 Swift 异步产出声纹前必然读到 false → 误报「时长不足」。→ `enroll-finalize` 改为在 `voiceprint`/`enroll_failed` 事件上**权威 resolve `{ok}`**（8s 超时兜底）。
- **[中] CoreML 跑在主 RunLoop**：`label()` 的 fbank+推理同步阻塞驱动 55s 交接定时器的主线程。→ 移到后台串行队列，算完再从后台→主线程 emit final（带 role），交接续逻辑不被阻塞。
- **[低] 一组**：退化嵌入(近零范数)→误判 `.speaker`（embed 返回 nil 落回 .unknown）；`minEmbedSamples` 8000→8400 对齐转换器 RangeDim 50 帧下限；录入内存按输入帧数而非 buffer 计数限界；AVAudioConverter 尾部延迟注释澄清；`--check-fbank` 指标加 max-abs/均值减余弦防"假通过" + 修正 CMN 注释错误；删未用 `tempfile`；`startListening` 重入守卫防叠加监听器；arm 幂等守卫。

## 已知遗留（均潜伏在未上线模型之后，需真机/调优）

1. **单麦门控分段**：门控 mic 仅 final 带 role，listening/interim/endpoint 默认 self→display-only，导致整段 55s 作为一段进分类、且纯门控场景 `listening` 状态可能不置位。重入守卫已挡住最严重的叠加监听器；按问切分需真机验证（可让 Swift 在门控+已录入时给 listening/interim/endpoint 也打 speaker role）。
2. **降级武装覆盖**：仅在 system 通道发 JSON `error` 时武装；静默崩溃 + 重试耗尽的边缘路径未挂钩（可抽 `maybeArmSingleMicFallback` 复用到 `proc.on('exit')`）。
3. **退避重启丢声纹**：`loadVoiceprintOnListening` 首个 listening 即消费；mic 崩溃退避重启后不再恢复声纹（应在 `proc.on('exit')` 按 `ch.gate` 重置）。
4. **system 恢复后双分类**：手动 retry 成功后未解除 mic 门控，可能 system tap 与门控 mic 回声重复分类同一问题。
5. **打包**：`CAMPlusSpeaker.mlmodelc` 未加入 `extraResources`（electron-builder 对缺失 from 可能报错，故暂不加），dev 能找到但打包会漏——上线模型时必须同 PR 加 extraResources 条目（README 已记录）。

## 下一步（需外部资源，非纯代码）

登录 ModelScope 核实 CAM++ zh_en 权重 license → 跑转换脚本得 `.mlmodelc` → `--check-fbank` 过对齐门 → 加 extraResources → 真机录入 + 标定 τ_high/τ_low → 验收单麦回退全流程，并处理上述遗留 1–4。
