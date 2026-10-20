# 双模式交易账本功能规格

依据本地华夏 005698、广发 270023 的 2026-09-28 双模式模板，2026-10-15 核对。本文只记录通用功能和公式，不含账户数据。国富 006373 未发现同类工作簿，使用同一计算引擎和独立账本。

## 原表结构与页面映射

每本模板包含“持仓总览”和“逐笔交易”。网页首页列出四只基金，每只基金进入独立账本页面；基金页呈现总览和历史记录，以展示为主，不提供交易编辑表单。

| 原列 | 意义 | 输入或引擎字段 |
| --- | --- | --- |
| A | 净值日期 | date，YYYY-MM-DD，成交确认单的净值日期 |
| B | 类型 | buy / sip / sell / reinvest / dividend / transfer-in |
| C | 成交净值 | nav |
| D | 确认份额 | shares |
| E | 确认金额或历史转入成本 | amount / cost；普通新增自动计算 |
| F | 实际手续费 | fee，必须显式填写，免费填零 |
| G | 确认状态 | status，可省略，默认 confirmed |
| H | 说明 | 通用说明，不影响计算 |
| I | 录入检查 | status、error |
| J | 份额变动 | shareChange |
| K | 交易后份额 | sharesAfter |
| L | 交易前市值 | valueBefore |
| M | 可提取利润 | availableProfit |
| N | 本笔提取利润 | profitWithdrawn |
| O | 本笔收回本金 | principalRecovered |
| P | 清仓确认亏损 | closedLoss |
| Q | 交易后本金 | principalAfter |
| R | 交易后市值 | valueAfter |
| S | 交易后盈亏 | holdingProfit |
| T | 交易后收益率 | holdingReturn |
| U | 累计投入及转入成本 | totalInvested |
| V | 累计收回 | totalRecovered |
| W | 累计提取利润 | totalProfitWithdrawn |
| X | 累计结清亏损 | totalClosedLoss |
| Y | 累计总盈亏 | totalProfit |
| Z、AB | 最近已计入成交的净值日期、净值 | lastDate、lastNav |
| AA | 计算链状态 | 前序错误会阻断后续计账 |

五项新增录入是日期、类型、净值、份额和手续费。买入和定投金额为 `ROUND(净值 × 份额 + 手续费, 2)`，卖出金额为 `ROUND(净值 × 份额 − 手续费, 2)`。红利再投金额和手续费都为零，增加份额但不增加现金投入。现金分红须填写实际到账金额，份额和手续费为零。转换转入须填写实际转入成本。历史记录的实际金额优先保留，不根据金额重新推算确认份额。

## 双模式算法

这是卖出到账的本金与利润分配方式。两种模式都保留同一份额、市值和累计总盈亏；切换模式要从头重算全部历史，剩余本金、已提利润及持有收益率随之改变。模板本身没有 FIFO 批次成本分配，不应将另一份交易分析中的 FIFO 添加为第三种模式。

设前序份额为 S，前序本金为 P，本笔净值为 N，手续费为 F，本笔到账或投入金额为 A。

- 交易前市值 `V = ROUND(S × N, 2)`。
- 卖出可提利润 `M = MAX(V − P − F, 0)`。
- 利润优先卖出：提取利润 `W = MIN(A, M)`。
- 本金优先卖出：提取利润 `W = MAX(A − P, 0)`。
- 现金分红始终采用利润优先：可提利润 `M = MAX(V + A − P, 0)`，提取利润 `W = MIN(A, M)`。
- 卖出或现金分红收回本金 `C = MIN(P, MAX(A − W, 0))`。
- 全部赎回后的结清亏损 `L = MAX(P − C, 0)`；其他交易为零。
- 后续本金 `P' = ROUND(P + 本笔新增投入 − C − L, 2)`。买入、定投、转入的金额构成新增投入。
- 后续份额按六位小数保存；买入、定投、转入、再投增加份额，卖出减少份额，现金分红不改变份额。
- 交易后市值 `V' = ROUND(后续份额 × N, 2)`；持有盈亏 `H = ROUND(V' − P', 2)`。
- 持有收益率 `H / P'`，本金为零时为空。
- 累计总盈亏 `ROUND(市值 + 累计收回 − 累计投入, 2)`。
- 累计收益率为累计总盈亏除以累计投入，分母为零时为空，非年化。
- 恒等式：累计总盈亏等于持有盈亏加累计提取利润减累计结清亏损；误差须小于两分。

全部赎回后，本金和份额归零，未收回本金归入累计结清亏损。随后再次买入重新累计当前本金，累计历史投入与总盈亏继续保留。

## 估值净值

源模板中的公布净值需手动更新，不联网。系统在有效的公布净值与最后已计入交易净值中选择日期较新者；同日优先公布净值。删除交易会自动回退到剩余历史的最后有效净值。模板的总览估值日期必须不早于末笔成交净值日期。网页可用各基金公开净值缓存填充公布净值；净值缓存是公开数据，与账户数据分离。

三只基金现有公开日净值文件均为数组，行结构是 `{date: string, nav: number, growth_pct: number, event: string}`。净值日期与同步、抓取日期必须分别标注。

## 检查与状态

确认记录可以标记 confirmed / estimated，或使用对应中文“已确认／历史估算”；省略状态默认已确认。pending／待确认跳过计账；cancelled、failed、closed 或撤单、交易失败、交易关闭均排除计账。排除和待确认不改变已确认的计算链。

必须检查有效日期、合法交易类型、正净值、数字份额、非负手续费；日期按成交净值日期非递减，同日维持原录入顺序。买卖和再投份额须为正，现金分红份额须为零。红利再投、现金分红之前必须有持仓。卖出不得超过已有份额，比较容差为百万分之一份；赎回费不得达到赎回总额。现金分红与红利再投手续费须为零。

历史买入、定投、转入实际金额的核对关系为 `ABS(金额 − 费用 − 份额 × 净值) <= tolerance`；历史卖出为 `ABS(到账 + 费用 − 份额 × 净值) <= tolerance`。源表 tolerance 默认 0.1。申购费不得达到总支出。网页引擎亦允许显式 amount 用于历史核对，普通新增使用自动金额。

首笔错误会标记 error，后续 active 记录 blocked，整个总览 valid=false，敏感汇总计算值置空；应先修正错误再显示总览。错误文本只包含行号和原因，不嵌入用户数字。

## 引擎契约

`calculateLedger(transactions, {mode='profit-first', valuationNav=null, valuationDate=null, openingPrincipal=0, openingShares=0, tolerance=0.1}={})` 返回 `{rows, summary, errors}`。

交易形状：`{id?, date, type, nav, shares, fee, amount?, cost?, status?}`。mode 为 profit-first 或 principal-first。期初本金用于累计投入的起点；期初份额只作起始持仓。正常使用从首次真实成交开始录入完整历史。

rows 在原字段外附加上表计算字段，以及从一开始的 index；status 为 included、excluded、pending、error 或 blocked；错误行带 error 文本。excluded、pending 只携带延续状态，不制造本笔盈亏。

summary 字段为 `{valid, shares, principal, marketValue, holdingProfit, holdingReturn, totalInvested, totalRecovered, totalProfitWithdrawn, totalClosedLoss, totalProfit, totalReturn, principalStatus, includedCount, pendingCount, estimatedCount, valuationNav, valuationDate, lastNav, lastDate, identityCheck}`。principalStatus 为 empty、recovered、invested，分别对应已清仓、本金已收回、仍有本金。pendingCount 包括待确认、错误和阻断行。errors 元素为 `{index, message}`，index 为一开始的行号，设置错误使用零。

## 华夏与广发差异

两表核心计算公式一致。华夏汇总投入字段称“累计投入及转入成本”，存在转换转入历史；广发称“累计买入支出”。华夏项目惯例的普通历史申购费率为 0.15%，广发模板历史估算说明采用 0.16%；二者仅用于说明旧记录的估算来源，新录入必须使用成交单实际手续费，不自动套用旧费率。

源模板含账户私人历史，绝不可将工作簿原件、明文交易 JSON 或截图直接纳入公开站点。经用户新授权，加密导出脚本仅在内存读取历史和序列化，再用 PBKDF2-SHA256（600000 次、16 字节随机盐）派生 AES-256-GCM 密钥，使用 12 字节随机 IV，仅写入加密信封。密码从标准输入读取，不写源码或日志。国富无模板历史，初始为空账本。

## 实际源表核验摘要

2026-10-15 在内存中逐项核验，未生成明文数据副本，未修改原工作簿。华夏源表有效历史为 110 行，广发为 128 行，原默认模式均为 profit-first。

两本原表的 11 个总览字段（市值、本金、持有盈亏、持有收益率、份额、累计投入、累计收回、累计提取利润、累计结清亏损、累计总盈亏、累计收益率）全部与工作簿缓存一致，无不匹配或缺失缓存。两种分配模式又各自与独立 Python 源公式参考实现逐行核验，17 个逐笔计算字段全部一致。缓存本身仅保存原默认模式，因此本金优先核验指公式参考实现核验，并非声称原文件含另一套模式缓存。

加密导出逐项保留了日期、类型、净值、确认份额、实际手续费、历史实际金额、转入成本、状态及原分配模式，行数一致；源文件哈希前后未变。国富未发现对应工作簿，不推断或补造历史记录。

## 本地维护数据源

脚本可二选一使用 `--workspace <项目目录>` 导入原表，或 `--source <本地 JSON>` 导入手工维护的标准交易源。标准空结构见 `scripts/ledger-source.example.json`，可复制为 `ledger-source.local.json` 后仅在本地编辑；该本地文件名已加入忽略规则。源结构固定包含四个基金代码及各自 transactions、mode，脚本严格检查字段、类型、日期和有限数字。createdAt 可省略，由脚本自动产生加密包时间。明文源不得提交，脚本不会打印源内容或另写明文副本。

再次以 `--workspace` 更新华夏、广发时，如目标密文已经存在，脚本先使用同一输入密码在内存解密，保留国富、银华等其余基金；密码错误或旧包不通过校验时立即中止，不覆盖原密文。

## 只有申请记录的截图

`scripts/import-guofu-screenshot.py` 通过系统 Windows PowerShell 的 Windows.Media.Ocr 在本机识别指定原图。分块、放大、右栏裁切及 OCR 文本只存在于内存，不生成原图副本、裁剪文件、明文 OCR 或交易 JSON。它从原尺寸与多个右栏 OCR 结果中建立重复一致的金额锚点，输出仅有验证数量。

国富本次截图包含 24 条申请，最近两条进行中，一条撤单，其余记录缺少成交确认资料。人工在原图确认了三处金额相等关系和两处申请时间修正；脚本仅记录行号、相等关系和时间，不含任何金额常量。生成记录按申请时间正序，`date` 为空，`nav`、`shares`、`fee` 均为 null，不推断成交净值日期或确认份额。

此类基金条目使用 `incomplete: true` 和 `sourceNote`。交易另有 `submittedAt`、`sourceStatus`，其状态只能为 pending 或 cancelled；sourceStatus 为 processing、unverified 或 cancelled。该结构仅用于展示申请列表，不得计入收益计算。补全真实确认单后才可改为普通成交账本。导入仅替换国富条目，保留密文内其他基金；密码仍从标准输入读取，重写内容仍只有加密信封。

## 每日日期口令信封

当前默认输出 version 2：随机 32 字节 dataKey 使用 AES-256-GCM 加密完整 payload；keys 包含按闰年日历枚举的 366 个 MMDD 项，每项有独立随机盐和 IV，用 PBKDF2-SHA256（600000 次）从对应日期代码派生 KEK，再用 AES-GCM 封装同一个 dataKey。所有记录及 sourceNote、note 等内容仍在唯一的 payload 密文中。

Python 与前端按北京时间选择当天 MMDD，v2 解密函数拒绝其他输入。目标已经为 v2 时，更新脚本解包并重用现有 dataKey 和 366 项 keys，只为更新的 payload 生成新随机 IV，因此日常维护不重复计算全部日期包装项。

`scripts/migrate-daily-password.py` 从标准输入读取旧口令，兼容解密原 v1，完成全部新包装项后才原子替换密文。迁移保留原 createdAt 与完整基金结构，不保存旧口令。首次包装使用四个工作线程，只输出进度计数和最终各基金保留记录数。v1 读取兼容保留，但新增或更新默认生成 v2。

日期代码是公开可推知的访问门禁，不能作为账户数据的强保密凭证。三分钟会话到期由前端处理，不改变静态密文的离线可解密性。

