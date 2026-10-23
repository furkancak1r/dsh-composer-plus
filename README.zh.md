# dsh-composer-plus — 适用于 DeepSeek Harness 的 Composer Plus

[![npm](https://img.shields.io/npm/v/dsh-composer-plus)](https://www.npmjs.com/package/dsh-composer-plus)
[![test](https://github.com/furkancak1r/dsh-composer-plus/actions/workflows/test.yml/badge.svg)](https://github.com/furkancak1r/dsh-composer-plus/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **中文** · [Türkçe](README.tr.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Bahasa Indonesia](README.id.md) · [Tiếng Việt](README.vi.md) · [हिन्दी](README.hi.md)

本文是译文，内容以英文版 [README.md](README.md) 为准。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）桌面版和网页版界面带来 Codex 风格的实用功能：改动面板、滑动卡片式的功能创意、能搜索消息文字的侧边栏搜索、可同时恢复文件的回合回退、把对话删除到废纸篓、输入框下方的项目名称、侧边栏中的项目状态、输入历史、计划模式快捷键、一键继续、重启后继续运行中的对话、队列拖拽排序、会话深层链接、以 Markdown 格式导出对话、按对话授予的 Auto Review 许可、后台通知、通过 Tether 应用在 iPhone 上访问，以及自动更新。

**一句话概括：** 这是一个 DeepSeek Harness 插件（npm 包 `dsh-composer-plus`，在 设置 → 插件 中显示为 **Composer Plus**）。它添加了 git 改动面板、Tinder 式的功能创意卡片、也能查找消息中词语的侧边栏搜索、↶ 回合回退（仅对话，或对话和文件）、删除对话、输入框下方的项目名称、↑/↓ 输入历史、Shift+Tab `/plan` 切换、一键 ▶ 继续、重启后继续、拖拽调整队列顺序、复制会话链接、导出为 Markdown、Auto Review “本对话内允许”、后台通知、iPhone 访问（手机连接，Tether 应用）、11 种额外界面语言和自动更新。

<p align="center"><img src="docs/images/hero.webp" width="820" alt="装有 Composer Plus 的 DeepSeek Harness：正在运行的项目在侧边栏中显示加载图标，改动面板显示 git diff"></p>

这是非官方的社区插件。插件只在检查更新时访问网络（GitHub releases 和 npm registry）；关闭 **自动更新** 后，启动时就不再发出这些请求。只有在你点击 **推荐功能** 时，**功能创意** 才会调用对话自己的模型。**下一条消息预测**（默认开启）每完成一个回合都会调用一次在设置中选择的模型（除非你另选，否则为 dsh 的默认模型），不需要点击；在 **设置 → Composer Plus** 中关闭它，即可停止这些调用。**输入时补全**（默认关闭）在你开启后，会在你每次输入停顿时调用为它选择的模型（默认使用预测的模型）。**手机连接**（默认关闭）只有在你开启后，才会接受来自本地网络或 tailnet 的 iPhone 连接。

## 安装

**桌面应用：** 设置 → 插件 → **添加插件** → 输入 `dsh-composer-plus` → **立即启用**。
也可以粘贴 `https://github.com/furkancak1r/dsh-composer-plus` 来代替 npm 包名。

**网页版 / CLI profile：**

```sh
dsh plugin --profile web add dsh-composer-plus
```

然后重启 dsh。（CLI 无法安装到桌面版 profile 中；桌面版 profile 由应用自己管理。）

> dsh 使用的 pnpm 会跳过发布不到 24 小时的版本。刚发布新版本时，请加上版本号：`dsh-composer-plus@1.11.2`。

## 功能

| 功能 | 使用方法 | 截图 |
|---|---|---|
| **改动面板** | 右侧边栏 → `+` → **改动**。选择 **未提交**、**未暂存**、**已暂存** 或 **分支**，即可查看有改动的文件及其 `+/-` 行数；点击某个文件可查看它的差异。**上一轮** 会打开 dsh 自带的最近一轮改动审阅。 | <a href="assets/features/changesPanel.webp"><img src="assets/features/changesPanel.webp" width="160" alt="改动面板截图"></a> |
| **功能创意** | 右侧边栏 → `+` → **功能创意** → **推荐功能**。对话自己的模型会读取对话所属项目的简短概要（顶层文件、README 和清单文件的开头部分、最近 15 次提交），并推荐最多 8 个功能。这些功能以一叠卡片的形式显示，语言与 dsh 的界面语言一致。向右滑动卡片（或点击 **✓**，或按 `→`；无论哪种方式，卡片都会飞向对应的一侧），即可在同一项目中新建对话：新对话以计划模式启动，并把该创意作为请求，因此在你批准计划之前不会有任何改动。要跳过计划，请点击 **▶ 直接实现**（或按 `↑`；卡片会向上飞出）：新对话会立即启动，并把该创意作为普通请求，模型会做出改动并运行检查（审批照常适用）。向左滑动（或点击 **✕**，或按 `←`）可跳过；**撤销**（或按 `Z`）可找回跳过的卡片。点击 **↓**（或按 `↓`）可把好的创意留到以后：它会进入项目的 **稍后** 列表，同一项目文件夹中的每个对话都会显示这个列表（重启后也一样）。**稍后（N）** 会打开这个列表；**规划** 会为该创意启动同样的计划模式对话，**直接实现** 则启动不做规划的对话，两者都会把它从列表中移除；**全部合并规划（N）** 会为列表中的所有创意启动一个计划模式对话，因此共同的部分只需规划一次；**从列表中移除** 会删除它。**复制为清单** 会把整个列表以 Markdown 清单的形式复制到剪贴板（`- [ ] Title — Summary`，每个创意一行），可用于问题跟踪器或 TODO 文件；它不会发起任何网络请求。**更多创意** 会添加更多卡片。如果只想获得某一方面的创意，请在 **推荐功能** 旁边的输入框中输入一个简短的 **关注主题**（最多 80 个字符；按 `Enter` 也会开始推荐），或点击输入框下方的某个固定主题：**性能**、**无障碍**、**测试**、**安全**、**易用性** 或 **文档**（再次点击可清除）。之后，模型只会推荐与该主题相关的功能；输入框为空表示不限主题。同一项目中不会重复推荐同一个创意：每个推荐过的创意（跳过的、留到以后的或已开始的）都会进入项目的 **历史**，模型会被告知不要再推荐这些创意，标题重复的创意会被丢弃。**历史** 会列出这些创意，并标为 **已开始** 或 **已建议**；**忘记**（或 **全部忘记**）可让某个创意再次出现；仍在 **稍后** 列表中的创意不会被推荐，直到你从该列表中移除它。只有在你点击时才会调用模型。 | <a href="assets/features/featureIdeas.webp"><img src="assets/features/featureIdeas.webp" width="160" alt="功能创意截图"></a> |
| **内容搜索** | dsh 自带的侧边栏搜索（**工作区** 旁边的放大镜；桌面应用中按 `Cmd+K`，浏览器中按 `Cmd+Alt+K`）不仅能按标题查找对话，还能按你的消息和回复中的词语查找对话，并在对话下方显示匹配的文字。dsh 本身已经带有这个搜索功能，但默认是关闭的；本功能会开启它，并在你的电脑上为它提供一个搜索索引文件。每次启动后的第一次搜索会创建索引（250 个对话约需 15 秒，见“限制”），之后的启动会继续使用这个索引。默认开启；更改在重启 dsh 后生效。 | <a href="assets/features/contentSearch.webp"><img src="assets/features/contentSearch.webp" width="160" alt="内容搜索截图"></a> |
| **回合回退** | 将鼠标悬停在你的某条消息上，点击 **↶**（在“复制”旁边）。**仅对话** 会把这条消息及其后的所有内容（回复、工具调用）从对话和模型上下文中移除，并把这条消息放回输入框：修改后再次发送即可。**对话和文件** 会先列出这条消息之后发生变化的项目文件，然后把它们也恢复原样。这也包括命令（`bash`）所做的更改，而不只是 dsh 编辑工具所做的更改。正在运行的回合会先停止。对话日志永远不会被重写：一个隐藏标记会隐藏被撤回的部分，方式与 dsh 自带的 `/compact` 隐藏旧消息相同。如果安装了 [dsh-rewind-plugin](https://www.npmjs.com/package/dsh-rewind-plugin)，则由它负责这项工作，Composer Plus 不会再显示第二个按钮。 | <a href="assets/features/turnRollback.webp"><img src="assets/features/turnRollback.webp" width="160" alt="回合回退截图"></a> |
| **删除对话** | 侧边栏 → 对话的 **…** 菜单（或右键点击）→ **删除…** → **删除**。dsh 本身只能归档。对话会停止（包括它的回合、后台任务、子代理和定时任务，与 dsh 自带的归档相同），它保存的历史记录连同子代理对话会移到 macOS 废纸篓（在其他系统上为 `$DSH_HOME/trash`）。要找回它，请把文件夹放回原处并重启 dsh：它会显示在侧边栏的 **仅显示已归档** 视图中。 | <a href="assets/features/deleteChat.webp"><img src="assets/features/deleteChat.webp" width="160" alt="删除对话截图"></a> |
| **输入框中的项目名称** | 输入框下方那一行（回合数、token、缓存命中、上下文）以对话的项目名称开头，让你随时知道对话在哪个项目中工作。这里显示的是 dsh 自己的项目标题；项目没有标题时，显示文件夹名称。将鼠标悬停在上面可查看完整的文件夹路径。点击它可在侧边栏中找到该对话（列表视图和项目视图均可）：侧边栏和项目会展开（折叠的项目及其 **显示更多** 也会展开），列表会滚动到该对话，该对话会闪烁 5 秒。 | <a href="assets/features/projectName.webp"><img src="assets/features/projectName.webp" width="160" alt="输入框中的项目名称截图"></a> |
| **输入历史** | 在空输入框中按 `↑` / `↓`，可以像在终端里一样浏览你发送过的消息。 | <a href="assets/features/inputHistory.webp"><img src="assets/features/inputHistory.webp" width="160" alt="输入历史截图"></a> |
| **计划模式快捷键** | `Shift+Tab` 会在草稿开头添加 `/plan `（再按一次可移除）。如果对话已处于计划模式，`Shift+Tab` 会退出计划模式。 | <a href="assets/features/planToggle.webp"><img src="assets/features/planToggle.webp" width="160" alt="计划模式快捷键截图"></a> |
| **保持输入框焦点** | 发送 `/` 命令或技能后，光标仍留在输入框中，你可以立即继续输入。对于输入命令后按 `Enter` 的键盘宏，这同样有效。dsh 在解析命令时会把输入框设为只读，浏览器随后会移除焦点。本功能会把焦点放回输入框，除非菜单、对话框或其他输入框正持有焦点。 | <a href="assets/features/keepFocus.webp"><img src="assets/features/keepFocus.webp" width="160" alt="保持输入框焦点截图"></a> |
| **一键继续** | 回合被停止、失败或中断后，空输入框会显示 **▶**。点击一次即可在现有对话的基础上继续，不需要在输入框中输入内容，也不会添加可见的对话消息（模型会收到一条简短的隐藏提示“从停止的地方继续”，因为部分提供商，例如 Claude，会拒绝以助手回复结尾的请求）。队列中的消息会保留：▶ 只继续被停止的任务，之后再运行队列。已完成的回合仍显示普通的发送按钮。 | <a href="assets/features/continueButton.webp"><img src="assets/features/continueButton.webp" width="160" alt="一键继续截图"></a> |
| **重启后继续** | 默认关闭：请在 **设置 → Composer Plus** 中开启。如果你在对话仍在运行时退出 dsh（或 dsh 被关闭），再次打开 dsh 后，该对话会自动继续，并使用与“一键继续”相同的隐藏提示。如果当时有目标轮次（`/goal`）正在运行，该目标会继续下一轮（dsh 每次启动时都会暂停目标，直到你恢复它们）。你停止的、已完成的或失败的对话不会继续。dsh 本身没有这项设置：它只会把这样的回合标记为已中断。 | <a href="assets/features/resumeAfterRestart.webp"><img src="assets/features/resumeAfterRestart.webp" width="160" alt="重启后继续截图"></a> |
| **队列拖拽排序** | 排队的消息会带一个把手（⠿）。拖动它即可调整顺序，或者让把手获得焦点后按 `↑` / `↓`。按 `Esc` 取消。 | <a href="assets/features/queueReorder.webp"><img src="assets/features/queueReorder.webp" width="160" alt="队列拖拽排序截图"></a> |
| **复制会话链接** | 在侧边栏中右键点击对话 → **复制会话链接**。把 `dsh-session:…` 链接粘贴到另一个对话中，即可把那个对话作为只读上下文附加进来。dsh 0.2.1 自带 **复制 Session ID**，它只复制纯 ID；本菜单项紧跟在它后面。 | <a href="assets/features/copyDeeplink.webp"><img src="assets/features/copyDeeplink.webp" width="160" alt="复制会话链接截图"></a> |
| **将对话导出为 Markdown** | 在侧边栏中右键点击对话（或打开它的 **…** 菜单）→ **导出为 Markdown…**。对话框会显示该对话有多少条消息；**复制到剪贴板** 会把对话以 Markdown 格式复制，**保存 .md 文件** 会通过浏览器的下载功能把它保存为 `<chat title>.md`（dsh 桌面版：按你的系统设置，保存到“下载”文件夹或打开保存对话框）。文件包含对话标题、项目名称和日期，之后每条消息各有一个 `## 你` 或 `## 助手` 部分。代码块保持原样；如果某条消息中的代码块没有闭合，它会被闭合。 | <a href="assets/features/exportMarkdown.webp"><img src="assets/features/exportMarkdown.webp" width="160" alt="将对话导出为 Markdown 截图"></a> |
| **复制项目路径** | 在侧边栏中右键点击项目 → **复制路径**，即可复制它的文件夹的完整路径。 | <a href="assets/features/copyProjectPath.webp"><img src="assets/features/copyProjectPath.webp" width="160" alt="复制项目路径截图"></a> |
| **新对话中的项目搜索** | 新对话 → 输入框上方的项目按钮。项目按 A–Z 顺序显示，顶部有 **搜索项目** 框。输入名称的一部分（不区分大小写和重音符号），按 `Enter` 即可选择第一个匹配项。没有匹配项时会显示 **没有匹配的项目**。侧边栏中 dsh 保存的项目顺序不会改变。 | <a href="assets/features/projectPicker.webp"><img src="assets/features/projectPicker.webp" width="160" alt="新对话中的项目搜索截图"></a> |
| **下一条消息预测** | 默认开启；可在 **设置 → Composer Plus** 中关闭。智能体完成一个回合后（被停止或失败的回合除外），空输入框会以灰色文字显示对你下一条消息的猜测，并带有 **按 Tab 接受** 提示。`Tab` 会把文字放入输入框，但不会发送。`Esc` 会在本回合隐藏它。开始输入也会隐藏它，新的回合会替换它。开关下方的 **模型** 菜单列出 dsh 自己的模型（与 dsh 模型菜单的列表相同）。默认选中 **dsh 默认**，它跟随 dsh 的默认模型。每完成一个回合会进行一次简短的模型调用。在 Tether 中，猜测显示在空输入框上方：轻点它即可放入输入框。 | <a href="assets/features/nextPrediction.webp"><img src="assets/features/nextPrediction.webp" width="160" alt="下一条消息预测截图"></a> |
| **输入时补全** | 默认关闭；可在 **设置 → Composer Plus** 中开启。输入时，光标后紧跟的灰色文字会显示你的消息可能的后续内容。`Tab` 会把它添加到消息中，但不会发送。`Esc` 会隐藏它。它只建议你自己接下来要写的话：不会回答你，也不会编造错误信息或名称。消息看起来已完整，或模型不确定时，不显示任何内容。继续输入灰色文字中接下来的字符时，它会保留，不会再次调用模型。它的开关下方有自己的 **模型** 菜单。第一项 **与“下一条消息预测”相同**（默认）使用 **下一条消息预测** 的模型；选择其他模型，就可以为每个功能使用不同的模型，例如为补全选择更快的模型。你每次输入停顿时，它都会调用一次模型，因此消耗的 token 比预测多得多：请选择快速、低成本的模型。输入斜杠命令、消息中带有文件标签，或光标不在末尾时，它不会运行。在 Tether 中，输入时剩余部分会显示在输入框上方：轻点它即可添加。 | <a href="assets/features/typingCompletion.webp"><img src="assets/features/typingCompletion.webp" width="160" alt="输入时补全截图"></a> |
| **本对话内允许** | 当 Auto Review 询问你时，审批卡片上会多出 **本对话内允许**：从此以后，同一对话中的同一工具都会被允许，参数不限。标题栏中的标签会列出这些授权，也可以撤销它们。授权在重启后仍然有效。 | <a href="assets/features/allowForChat.webp"><img src="assets/features/allowForChat.webp" width="160" alt="本对话内允许截图"></a> |
| **项目状态** | 侧边栏中的项目行会显示与其对话相同的加载图标 / 等待 / 完成标记。因此，即使项目已折叠，你也能知道其中有对话正在运行或需要你处理。等待你处理的对话优先显示，其次是你尚未打开的已完成对话（绿色圆点，即使另一个对话仍在运行也会显示），最后是加载图标。将鼠标悬停在上面可查看详情。 | <a href="assets/features/projectStatus.webp"><img src="assets/features/projectStatus.webp" width="160" alt="项目状态截图"></a> |
| **活跃项目置顶** | 当某个对话开始运行或需要你处理时，它所在的项目会移到侧边栏顶部，并使用 dsh 自带的行动画（与把它拖到那里的效果相同）。已完成的项目保持原位；你可以像往常一样把它们拖到任意位置。移动会保存到 dsh 的项目顺序中，因此关闭此功能后会保留当前顺序。 | <a href="assets/features/projectStatus.webp"><img src="assets/features/projectStatus.webp" width="160" alt="活跃项目置顶截图"></a> |
| **近期项目筛选** | 侧边栏 → 视图选项（滑块图标）→ **最近 2 小时内活跃**。选中后，侧边栏只显示最近 2 小时内有活跃对话的项目。活跃对话包括：这段时间内更新过的对话、正在运行或等待中的对话、当前打开的对话，以及你尚未打开的已完成对话（dsh 的绿色“完成”圆点），超过 2 小时后也一样。没有这类对话的项目会被隐藏，新建的空项目也会被隐藏。再次选择该项即可显示所有项目。这个选择保存在本设备上。 | <a href="assets/features/recentProjects.webp"><img src="assets/features/recentProjects.webp" width="160" alt="近期项目筛选截图"></a> |
| **折叠全部项目** | 侧边栏中有项目展开时，视图选项（滑块图标）旁边会出现一个按钮。点击它可以一次折叠所有展开的项目，例如 5 个项目中展开的 3 个。没有展开的项目时，这个按钮会再次隐藏。 | <a href="assets/features/collapseProjects.webp"><img src="assets/features/collapseProjects.webp" width="160" alt="折叠全部项目截图"></a> |
| **按状态排序** | 侧边栏 → 视图选项 → **排序方式** → **按状态**（配合 **单列表** 使用）。已完成的对话排在最前（即带 dsh “完成”圆点的对话，以出错结束的回合也会显示这个圆点），然后是正在运行或等待中的对话，再然后是带有活跃自动化任务（Schedule）的对话，其余对话按 dsh 的顺序排列。打开已完成的对话后，它会往下移。只有视图会改变：选择 **手动排序** 或 **最近更新** 即可恢复。 | <a href="assets/features/statusOrder.webp"><img src="assets/features/statusOrder.webp" width="160" alt="按状态排序截图"></a> |
| **后台通知** | dsh 在后台时，如果回合完成（通知显示回复的第一行），或对话确实在等你处理，你都会收到通知。等你处理的情况包括：审批（显示工具名称）、回答（显示问题）或计划审阅。请求必须在 1.5 秒后仍未处理，才会发出通知，因此被自动处理的审批（Auto Review 授权、其他插件）不会发出通知；请求一旦得到处理，对应的通知也会立即撤回。程序坞/任务栏角标会显示等待中的对话数量。点击通知会打开对应的对话。 | <a href="assets/features/notifications.webp"><img src="assets/features/notifications.webp" width="160" alt="后台通知截图"></a> |
| **11 种额外界面语言** | 设置 → Composer Plus → **应用语言** 可以把整个 dsh 界面切换为 Türkçe、Español、Português (Brasil)、Français、Deutsch、Русский、日本語、한국어、Bahasa Indonesia、Tiếng Việt 或 हिन्दी（见下文）。 | <a href="assets/features/language.webp"><img src="assets/features/language.webp" width="160" alt="11 种额外界面语言截图"></a> |
| **手机连接（iPhone）** | 通过 [Tether](tether/) 应用在 iPhone 上使用 dsh，可以在同一 Wi-Fi 下使用，也可以通过 [Tailscale](https://tailscale.com) 使用。请在 **设置 → Composer Plus** 中开启它（默认关闭，因为它会在这台 Mac 上开放一个网络端口）。然后点击侧边栏左下角的 **手机连接**：用 iPhone 相机扫描二维码（轻点 **Open in Tether**），或用 Tether 中的 **Scan code** 扫描，轻点 **Connect**，然后点击 **Approve**。请先安装 Tether：没有它，相机无法打开这个二维码。手机可以显示你的对话、发送消息、回答审批和问题，以及切换模型和智能体。你可以配对任意多台 Mac：点击应用左上角的 Mac 名称即可在它们之间切换。 | <a href="assets/features/mobileConnect.webp"><img src="assets/features/mobileConnect.webp" width="160" alt="手机连接截图"></a> |
| **自动更新** | dsh 启动时，插件会检查 [最新的 GitHub release](https://github.com/furkancak1r/dsh-composer-plus/releases/latest)。如果它比当前版本新，并且已发布到 npm，插件会通过 dsh 自带的插件管理器（与 设置 → 插件 相同的途径）安装这个确切的版本，并通知你。**重启 dsh** 即可加载新版本。**设置 → Composer Plus → Composer Plus 更新** 会显示版本号，并提供 **检查更新** / **立即更新**。 | <a href="assets/features/autoUpdate.webp"><img src="assets/features/autoUpdate.webp" width="160" alt="自动更新截图"></a> |

按钮、工具提示、提示信息和通知都会使用所选的 dsh 语言（见下文的“应用语言”）。

## 设置

每项功能都可以单独开启或关闭：dsh **设置 → Composer Plus**。每一行都有一张小截图：将鼠标悬停在上面可查看放大的预览，点击可按原尺寸打开（按 `Esc` 关闭）。顶部的 **搜索功能** 框会按名称或描述筛选页面（支持任何语言，不区分大小写和重音符号）；按 `Esc` 可清空。每一行都有一个开关和一段简短说明；更改会立即生效，不需要重启，并会保存在该设备上。除 **手机连接**、**重启后继续** 和 **输入时补全** 外，所有功能默认开启。这三项以及 **内容搜索**、**回合回退** 和 **下一条消息预测** 的开关由 dsh 的 Host 保存，因此它们对每个窗口都有效，并在重启后保留。**下一条消息预测** 和 **输入时补全** 的 **模型** 选择也由 Host 保存（**输入时补全** 默认 **与“下一条消息预测”相同**）。**内容搜索** 只有在重启 dsh 后才会改变（dsh 在启动时读取它）；在此之前，它所在的行会显示 **重启 dsh 后此更改生效。**

<p align="center"><img src="docs/images/settings.webp" width="720" alt="设置 → Composer Plus：功能搜索、语言选择器、更新行和每项功能的开关，悬停时显示截图预览"></p>

### 应用语言

打开 **设置 → Composer Plus → 应用语言**，然后选择 **系统语言** 或 13 种语言之一：

English · 中文 · Türkçe · Español · Português (Brasil) · Français · Deutsch · Русский · 日本語 · 한국어 · Bahasa Indonesia · Tiếng Việt · हिन्दी

<p align="center"><img src="docs/images/language-tr.webp" width="720" alt="已切换为 Türkçe 的 DeepSeek Harness 界面"></p>

整个应用会立即切换语言。这个选择保存在 dsh 自己的 `locale.preference` 中（与 通用设置 → 语言 是同一个设置），因此重启后依然有效。**系统语言** 会清除这个选择：桌面应用跟随操作系统语言，网页版跟随浏览器语言，不支持的语言会回退为英语。安装插件绝不会覆盖你已经选择的语言。

每个语言包有 3,143 条文本：dsh `0.2.0-rc.2` 和 `0.2.1-rc.2` 的全部界面文本（对话、侧边栏、设置、审批、自动化任务、文件预览、插件管理器、插件市场）、插件自己的控件，以及常用的 [dsh-rewind](https://github.com/SiriLee/dsh-rewind) 插件。以下内容不会翻译：你的消息、模型输出、代码、斜杠命令名称（`/plan`、`/compact`）、由提供商定义的标签（例如推理强度 `High`）、其他插件的文本，以及桌面应用的原生菜单和更新对话框（dsh 只提供这些内容的英文和中文版本）。较新版本的 dsh 新增的字符串，在语言包更新之前会以英文显示。如果其他插件已经提供了某种语言，该语言仍由那个插件提供。

## 键盘快捷键

| 按键 | 位置 | 操作 |
|---|---|---|
| `↑` / `↓` | 空输入框 | 上一条 / 下一条已发送的消息 |
| `Shift+Tab` | 输入框 | 添加/移除 `/plan `，或退出计划模式 |
| `↑` / `↓` | 获得焦点的队列把手 | 移动排队的消息 |
| `Esc` | 拖动过程中 | 取消移动 |
| `→` / `←` | 功能创意页面 | 实现 / 跳过最上面的卡片 |
| `↓` | 功能创意页面 | 把最上面的卡片保存到项目的“稍后”列表 |
| `↑` | 功能创意页面 | 不做规划，直接实现最上面的卡片 |
| `Z` | 功能创意页面 | 找回最后一张跳过的卡片 |
| `Enter` | 新对话的项目菜单，搜索框 | 选择第一个匹配项 |
| `↑` / `↓` | 新对话的项目菜单 | 在显示的项目之间移动 |
| `Esc` | 新对话的项目菜单，搜索框 | 清空搜索（再按一次关闭菜单） |
| `Tab` | 显示预测的空输入框 | 把预测放入输入框 |
| `Tab` | 光标后的灰色补全 | 把补全添加到消息中 |
| `Esc` | 显示预测的空输入框 | 隐藏预测 |

打开的 `/` 或 `@` 菜单会自己占用这些按键。

## 兼容性

已在 dsh `0.2.0-rc.2`（桌面版和网页版）和 `0.2.1-rc.2`（网页版）上测试。每次推送时，CI 都会运行测试。

## 隐私与安全

- **继续：** 经过身份验证的本地接口只会恢复最后一个被中断的回合，会拒绝过期或重复的请求，并保留现有的审批钩子。它不会发送新的用户消息。
- **重启后继续：** 在你开启之前一直关闭。Host 端只在 `$DSH_HOME/storages/dsh-composer-plus/resume.json`（仅所有者可访问）中保存对话 ID 和开始时间，任何数据都不会离开你的电脑。只有当 dsh 自己的日志表明是 dsh（而不是你）停止了最后一个回合时，它才会继续该对话。审批和 Auto Review 照常适用于继续的回合。

- **改动面板：** git 在你的电脑上、在对话自己的文件夹中以只读方式运行，并通过 dsh 经过身份验证的 `/api` 通道调用。它从不提交、暂存或拉取，只显示 git 自己列出的路径。
- **功能创意：** 在你点击 **推荐功能** 之前，什么都不会运行。点击后，Host 端只读取对话自己的文件夹（浏览器从不发送路径）：顶层条目的名称，README、AGENTS.md 和清单文件（`package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod` 等）的前 6 kB，以及 `git log --oneline -15`，总计最多 16 kB。它会跳过 `.env*`、密钥文件和 `node_modules` 等文件夹，并且只读取位于该文件夹内的普通文件：指向文件夹外部的符号链接、FIFO 或设备文件都会被跳过。这份概要会通过 dsh 自己的提供商设置，以一次请求的形式发送给对话所用的模型；它不会被添加到任何对话中。项目中的任何内容都不会被写入。向右滑动的创意会以计划模式新建对话，因此审批和计划审阅照常适用。**直接实现** 不使用计划模式启动对话：模型可以立即修改文件，对话平常的审批和 Auto Review 照常适用。留到以后的创意（标题、概要、理由、工作量）会与项目的文件夹路径一起，保存在 dsh home 下的 `storages/dsh-composer-plus/later.json` 中（仅所有者可访问的文件）；不会向项目写入任何内容。推荐过的创意的历史（标题、概要、理由、工作量、日期、是否已启动）也以同样方式保存在 `storages/dsh-composer-plus/idea-history.json` 中，每个项目最多 200 条（最早的先被移除）；该项目下次 **推荐功能** 时，这些标题会发送给模型。
- **内容搜索：** 没有新的代码来搜索你的对话：插件只是开启 dsh 自带的消息索引（SQLite FTS5，`dsh-session-query-sqlite`），并为它提供一个文件 `$DSH_HOME/cache/composer-plus/session-search.db`（文件和文件夹仅所有者可访问）。这个文件包含你的用户消息和助手消息的文本，因此它的私密程度与 `$DSH_HOME/sessions` 中的对话日志相同。任何数据都不会离开你的电脑。它是 dsh 可以重新生成的副本：你可以在 dsh 关闭时删除它。开关保存在 `$DSH_HOME/storages/dsh-composer-plus/content-search.json` 中。
- **回合回退：** 在你发送每条消息之前，Host 会在它自己的存储 `$DSH_HOME/cache/composer-plus/rollback/<chat>.git`（仅所有者可访问的文件夹）中，为对话的文件夹创建一个 git 快照。快照保存该文件夹中 git 能看到的文件（不包括被忽略的文件）的副本，因此它的私密程度与项目相同。它会读取你仓库中的对象（不会再复制一份 git 已有的内容），并且从不写入你仓库的索引、`HEAD`、分支、标签、stash 或配置；git 在你的仓库中做出的唯一更改，是更新它复用的对象文件的时间戳（这会推迟 `git gc` 对这些文件的清理）。带文件的回退只会写入对话文件夹内的普通文件；它会跳过符号链接、管道以及文件夹外的任何内容。任何数据都不会离开你的电脑。你可以在 dsh 关闭时删除这个存储（此后在发送新消息之前，回退只能用于对话本身）。**删除对话** 也会删除对话的存储。开关保存在 `$DSH_HOME/storages/dsh-composer-plus/rollback.json` 中。
- **将对话导出为 Markdown：** Host 端只读取对话自己的日志（即 dsh 显示的那些消息），并把它们交给页面；它不读取任何项目文件，也不通过网络发送任何内容。Markdown 只会进入你的剪贴板或你保存的文件。
- **删除对话：** 把对话自己的日志文件夹（`$DSH_HOME/sessions/<project>/<chat>`）移到废纸篓。它不会触碰项目文件夹。
- **本对话内允许：** 授权保存在 `$DSH_HOME/storages/dsh-composer-plus/grants.json` 中（仅所有者可访问）。一项授权只覆盖 **一个对话中的一个确切工具**。如果该工具可以写入，授权也覆盖任何写入操作。可以在标题栏的标签中撤销授权。
- Auto Review 仍会检查每一次调用；审查失败的调用永远不会被自动允许。
- **手机连接：** 在你开启之前一直关闭。开启后，Host 端会运行 Tether 网关：端口 19390 上的 HTTPS 服务只接受你的 Wi-Fi 子网和你的 tailnet（100.64.0.0/10）；另有一个位于 `127.0.0.1:19391` 的配对页面（仅限这台 Mac）。手机需要二维码中的一次性代码（5 分钟内有效），还需要你在 Mac 上点击 **Approve**。手机会固定（pin）网关的证书。Mac 只保存每部手机令牌的哈希值（有效期 30 天，使用期间会续期）；**Revoke** 会立即关闭该手机的连接。手机只能调用允许列表中的 dsh 方法（对话、提示词、附件、斜杠命令、审批、问题、模型、智能体、目标），不能访问设置、凭据、文件浏览器或终端。数据：`$DSH_HOME/storages/dsh-composer-plus/mobile/`。详情：[tether/README.md](tether/README.md)。
- **更新：** Host 端会向 `api.github.com` 查询最新版本，并向 `registry.npmjs.org` 查询这个确切的版本；不会发送任何关于你或你的对话的信息。安装使用 dsh 的插件管理器（`pnpm add dsh-composer-plus@<version>`；如果 dsh 0.2.1 对已安装的插件拒绝这样做，则使用 `pnpm add https://registry.npmjs.org/dsh-composer-plus/-/dsh-composer-plus-<version>.tgz`，之后 profile 会把这个 URL 列为插件的来源），因此 dsh 自己的 registry、脚本和版本兼容性检查都会生效。预发布标签和旧版本永远不会被安装。
- **下一条消息预测：** 默认开启；在 **设置 → Composer Plus** 中关闭它，即可停止这些模型调用。每完成一个回合，Host 端会把该对话中你自己的消息和智能体的文字回复（不含工具输出、隐藏上下文和推理内容），最多约 6,000 个字符（最新的部分），发送给所选的模型（除非你另选，否则为 dsh 的默认模型）。它通过 dsh 自己的提供商设置，以一次请求的形式发送。对话中不会保存任何内容：猜测不会被添加到对话历史中。开关和模型选择保存在 `$DSH_HOME/storages/dsh-composer-plus/predict.json` 中（仅所有者可访问的文件）。
- **输入时补全：** 在你开启之前一直关闭。开启后，你每次输入停顿时，Host 端会把你目前已输入的文字，以及该对话中你自己的消息和智能体的文字回复（不含工具输出、隐藏上下文和推理内容；对话部分最多约 3,000 个字符），发送给在 **输入时补全** 下选择的模型（默认为 **下一条消息预测** 的模型）。新的停顿会停止较早的请求。对话中不会保存任何内容。开关保存在 `$DSH_HOME/storages/dsh-composer-plus/complete.json` 中（仅所有者可访问的文件）。

## 故障排除

- **macOS 上没有通知：** 系统设置 → 通知 → DeepSeek Harness → 允许通知。选择 **提醒** 可以让通知一直留在屏幕上。
- **dsh 更新后，▶、队列把手、项目状态、近期项目选项、折叠全部项目、复制路径、项目搜索框、下一条消息预测、输入时补全、本对话内允许或右键菜单不见了：** 这些功能挂接在 dsh 当前的 HTML 上，因为 dsh 还没有为它们提供插槽。如果 dsh 修改了这部分标记，它们会自动隐藏；其他功能不受影响。请提交一个 [issue](https://github.com/furkancak1r/dsh-composer-plus/issues)。
- **“更新失败”或“不是从 npm 安装的”：** 从本地文件夹链接的副本或被重命名的副本无法自行更新；请在 设置 → 插件 中重新安装 `dsh-composer-plus`。在其他情况下，消息会显示 pnpm 错误的第一行；点击 **检查更新** 可重试。
- **手机连接提示网关未运行：** “no IPv4 address on en0”表示这台 Mac 没有 Wi-Fi/以太网地址；“EADDRINUSE”表示另一个 dsh（或其他应用）正在使用端口 19390 或 19391。同一时间只能有一个 dsh 运行手机连接。
- **手机连接、重启后继续或内容搜索提示“重启 dsh”：** 插件在 dsh 运行期间被更新了（对于内容搜索，也可能是你更改了开关）；新状态会在重启后加载。
- **搜索只能找到标题：** 内容搜索已关闭；或者你开启它或安装插件后还没有重启 dsh；或者这个词只出现在工具输出中（见“限制”）。
- **我的消息上没有 ↶ 按钮：** 回合回退已关闭；或者该对话是子代理对话；或者已安装 dsh-rewind-plugin（请使用它的 ↶ 按钮）。更新后，请重启 dsh。
- **“对话和文件”显示为灰色：** 项目不是 git 仓库；或者没有这条消息之前的快照（这条消息比插件更早，或者它的快照已被最新的 50 个快照替换）；或者没有文件发生变化。
- **删除时提示另一个 dsh 已打开此对话：** 使用同一 dsh home 的另一个 dsh 持有该对话的锁。关闭那个窗口或那个 dsh，然后再次删除。在此期间，对话会保持归档状态。
- **重启后对话没有继续：** dsh 退出时“重启后继续”处于关闭状态；或者你自己停止了那个回合；或者回合已经结束（完成或失败）；或者对话已被归档；或者当时有超过 20 个对话正在运行（只有最新的 20 个会继续）。
- **刚发布新版本时安装失败：** 请加上版本号（`dsh-composer-plus@1.11.2`），见上文的安装说明。

## 限制

- 不发送消息的“继续”依赖 dsh 的 `agent/pre-step` → `agent/request` 生命周期。升级 dsh 时，请重新检查兼容性。
- **功能创意** 会在内存中为每个对话保留卡片，直到 dsh 或页面重新加载；之后，**推荐功能** 会再次询问模型。卡片使用你点击时 dsh 的界面语言；更改语言后，已在卡片堆中的卡片保持原来的语言，**更多创意** 则使用新语言。模型只能看到简短的项目概要，看不到代码，因此某个创意可能与项目已有的功能重复：跳过它即可。只有当 profile 中有 dsh 的 `/plan` 命令时，新对话才会以计划模式运行；否则，创意会作为普通的第一条消息发送。**稍后** 列表属于对话的文件夹路径：通过符号链接打开的同一个文件夹有它自己的列表。每个项目最多保留 50 个创意（移除一个后才能再添加），相同的标题只保留一次。拖动卡片只能决定向左或向右；要保存卡片，请使用 **↓**；要直接实现，请使用 **▶**。重复只按标题判断：模型仍可能以新名称推荐以前的创意，跳过它即可。如果模型只返回以前的创意，就不会显示新的创意：请再点击一次。关注主题越窄，越容易出现这种情况；请换一个更宽的主题，或清除主题。在 dsh 或页面重新加载之前，每个对话的关注主题都会保留在输入框中。
- **将对话导出为 Markdown** 只包含你自己的消息和助手的文字回复：工具调用及其输出、推理内容、图片（用一行 `[image]` 标记）、隐藏上下文以及被回合回退或 dsh-rewind-plugin 移除的消息都不包含在内。同一回合的回复会合并为一个部分。一次导出最多包含约 400 万个字符；更长的对话只导出前面的部分，并附上一条说明。
- **重启后继续** 是继续回合，而不是重放回合。退出时正在运行的工具调用会以 dsh 的“结果未知”结果结束，模型会被告知不要重复已完成的工作，但不能安全运行两次的命令仍可能再次运行。当时打开的子代理、审批和问题不会恢复：它们的父对话会继续，并再次询问。每次启动最多继续 20 个对话。

- **内容搜索** 是 dsh 自带的搜索，因此也有 dsh 的限制。它只搜索用户消息和助手消息：不搜索工具输出（命令、文件内容、结果），也不搜索推理内容，并且不能按用户、助手或工具消息筛选。它匹配完整的词，而不是词的一部分（`deploy` 找不到 `deployment`）；不带重音的字母也能匹配带重音的字母（`seker` 能找到 `şeker`）。每个对话只显示一行，带有 dsh 的 240 字符摘录，最多显示 20 行。
- **内容搜索** 的开销（在 247 个真实对话日志的副本上测得：159 MB，dsh 0.2.1-rc.2，Apple Silicon，32 GB）：每次启动后的第一次搜索会构建索引，约需 15 秒。在此期间，dsh 的 Host 约有 7 秒不响应任何请求，因此其他对话会在这段时间内暂停流式输出（页面本身不会卡住）。Host 的内存在峰值时约增加 1.1 GB；一分钟后仍比启动时高约 0.5–0.6 GB，直到 dsh 退出。索引文件约 165 MB。之后的搜索约需 0.5 秒。重启后，第一次搜索约需 1 秒（只添加新的或有改动的对话），内存约增加 70 MB。如果你的电脑内存较少，请关闭此功能。
- **内容搜索** 只有在重启 dsh 后才会生效，并且索引文件由所有使用同一 dsh home 的 dsh 共享：同一时间只运行一个这样的 dsh（dsh 规定每个索引文件只能有一个所有者）。
- **回合回退** 只在 git 仓库中、并且只在对话的文件夹中恢复文件。每个对话保留最新的 50 个快照。被忽略的文件（`.gitignore`、`info/exclude`、你的全局忽略文件）、空文件夹、符号链接和子模块不会被恢复；创建快照时被忽略的文件永远不会被删除，即使该回合更改了忽略规则也一样。git 无法读取的文件不会进入快照。你每发送一条消息，就会对对话的文件夹执行一次 `git add --all`，写入私有存储：在包含大量未跟踪文件的超大文件夹中，这可能需要几秒钟，下一次工具调用会等待它完成（最多 10 秒；之后快照会在后台完成）。如果你仓库的 `git gc` 删除了旧快照需要的对象，该文件会被列为未恢复。只有消息的文字会回到输入框中：请重新添加它的图片或文件。子代理对话没有 ↶（子代理的文件更改算作启动它的对话的更改）。导出的对话（`/export`）中仍包含被撤回的消息。用一个隐藏标记撤回对话的一部分，这个思路来自 SiriLee 的 [dsh-rewind-plugin](https://github.com/SiriLee/dsh-rewind)（MIT）；Composer Plus 没有使用其中的任何代码。
- **删除对话** 需要 dsh 的归档功能（dsh 0.2.0 及更高版本）。如果对话（或它的某个子代理对话）在 15 秒内没有停止，或被另一个 dsh 持有，它会保持归档状态，不会移动任何内容。在 macOS 以外的系统上，废纸篓文件夹必须与对话历史位于同一磁盘。你删除的已打开对话会以归档和隐藏的状态留在 dsh 的内存中，直到 dsh 重启。请自行清倒废纸篓；dsh 不会替你清倒。
- dsh 的队列没有 `move` 操作，所以由插件的 Host 端在 dsh 的队列中直接移动排队的消息本身（一次改动，还是同一条消息）。带有图片或文件的消息也能移动。只有你自己的消息可以移动：队列中的目标轮次或对问题的回答会留在原处。如果在你拖动时有消息开始发送，则不会移动任何消息，并会显示一条提示说明这一点。
- 如果新版本不改动任何 dsh 设置，dsh 0.2.1 会立即加载更新；否则（以及在 dsh 0.2.0 上），请重启 dsh 来加载更新。插件从不替你重启 dsh。没有 dsh 插件管理器的网页版/CLI profile 只会提示有新版本。
- **保持输入框焦点** 只在发送 `/` 命令或技能后才会把焦点还给输入框。dsh 解析命令时，输入框会有几毫秒处于只读状态，因此这段时间内按下的键会丢失。如果 dsh 的 `/` 菜单仍然打开，`Enter` 会选择高亮的行，而不会发送。
- **手机连接** 只适用于 macOS（它使用 `en0`、`openssl`、`swift` 和 `dns-sd`）。它使用固定端口 19390 和 19391，因此每台 Mac 上同一时间只能有一个 dsh 运行它（每台 Mac 是手机 Mac 列表中的一项）。只有在 Tether 打开或刚转入后台时，手机才能收到通知（没有推送服务）。iOS 应用尚未上架 App Store：请用 Xcode 从 `tether/ios` 构建它。
- 会话链接在对话中有效；点击它不会打开对应的对话。
- 重启前发出的通知，点击后只会把 dsh 带到前台。
- 活跃项目通过 dsh 保存的项目顺序来移动，因此新顺序在重启后依然保留。不属于任何项目的对话（“未分组”）无法移动；dsh 总是把它们列在最后。
- dsh 在侧边栏的视图选项菜单中没有扩展点，所以近期项目选项被添加到 dsh 自己的菜单中。如果 dsh 更新修改了这个菜单，该选项将不会显示，所有项目都保持可见。筛选作用于项目行，因此 **单列表** 不会被筛选。请与 **按工作区** 一起使用：在 **按工作区树** 中，被隐藏的父文件夹也会隐藏其中的活跃项目。**按状态** 也有同类限制：dsh 没有排序插槽，因此该菜单项和行顺序依赖 dsh 的菜单和列表标记。
- dsh 也没有项目行菜单或“工作区”标题栏插槽。**复制路径** 通过 dsh 的行标记找到项目行；**折叠全部项目** 放在 dsh 的标题栏中，并用与点击项目行相同的方式折叠每个展开的项目。如果 dsh 更新修改了这些标记，右键点击会显示浏览器自己的菜单，按钮也不会显示。
- dsh 在新对话的项目菜单中也没有扩展点，所以 **搜索项目** 框和 A–Z 顺序依赖 dsh 的菜单标记。如果 dsh 更新修改了这些标记，菜单会按 dsh 自己的样子显示：使用保存的顺序，没有搜索框。A–Z 顺序只是一种视图，不会改变 dsh 保存的项目顺序。
- dsh 也没有输入框提示的扩展点，所以 **下一条消息预测** 的文字覆盖在 dsh 自己的占位文字（`[data-composer-placeholder]`）上。如果 dsh 更新修改了这部分标记，就不会显示预测。开启期间，每完成一个回合都会进行一次简短的模型调用。
- **输入时补全** 通过 dsh 自己的输入框提示显示文字（即 dsh 用于斜杠命令参数提示的 `--dsh-composer-hint` 样式）。输入斜杠命令、消息中带有文件或符号标签，或光标不在消息末尾时，它不会运行。如果 dsh 更新修改了这个样式，就不会显示补全。你每次输入停顿都会进行一次模型调用。
- 已向上游请求内置支持：队列 `move` 见 [#773](https://github.com/deepseek-ai/deepseek-harness/discussions/773)，“继续”状态见 [#9269](https://github.com/deepseek-ai/deepseek-harness/discussions/9269)。

## 常见问题

**如何为 DeepSeek Harness 添加改动 / git diff 面板？** 安装 `dsh-composer-plus`，然后打开右侧边栏 → `+` → **改动**。

**dsh 能像滑 Tinder 卡片一样为我的项目推荐功能吗？** 可以：右侧边栏 → `+` → **功能创意** → **推荐功能**。向右滑动会新建一个对话来规划该功能，点击 **▶ 直接实现** 会新建一个不做规划、立即实现该功能的对话，向左滑动则跳过。

**dsh 侧边栏搜索能按消息中的词语查找对话，而不只是按标题吗？** 可以，使用 **内容搜索**（默认开启）：安装插件后重启一次 dsh，然后使用 **工作区** 旁边的放大镜。匹配的对话会显示该词周围的文字。

**能像在 OpenCode 或 Claude Code 中那样撤销一个回合并编辑我的提示词吗？** 可以，使用 **回合回退**：点击消息上的 **↶**，选择 **对话和文件**，编辑回到输入框中的文字，然后发送。

**可以删除对话，而不是归档它吗？** 可以，使用 **删除对话**：**…** → **删除…**。历史记录会移到废纸篓，因此误删后可以恢复。

**如何查看对话属于哪个项目？** 看输入框下方那一行：开启 **输入框中的项目名称**（默认开启）后，这一行会以项目名称开头。将鼠标悬停在上面可查看文件夹路径。

**如何在 dsh 输入框中使用 ↑/↓ 消息历史？** 安装本插件；在空输入框中按 `↑` / `↓` 即可浏览你发送过的消息。

**如何不输入“继续”就让被停止或失败的 dsh 回合继续？** 使用本插件后，回合被停止、失败或中断时，发送按钮会变成 **▶**；点击一次即可继续。

**我退出并重新打开 dsh 后，正在运行的对话会继续吗？** dsh 本身不会：dsh 会把这样的回合标记为已中断并等待（目标也会等待 `/goal resume`）。开启 **设置 → Composer Plus → 重启后继续** 后，dsh 退出时正在运行的对话会在下次启动时自动继续。

**预测由哪个模型生成？** 由你在 **设置 → Composer Plus → 下一条消息预测 → 模型** 中选择的模型生成。这个列表就是 dsh 自己的模型列表。**dsh 默认** 跟随 dsh 的默认模型。如果 dsh 不再列出所选的模型，预测会改用默认模型。**输入时补全** 有自己的 **模型** 菜单：**与“下一条消息预测”相同**（默认）跟随预测的模型；选择其他模型时，该模型只用于补全。如果 dsh 不再列出这个模型，补全会改用预测的模型。

**如何在 dsh 中调整排队消息的顺序？** 拖动排队消息上的 ⠿ 把手，或者让它获得焦点后按 `↑` / `↓`。

**如何让 Auto Review 在同一个对话中不再反复询问同一个工具？** 点击审批卡片上的 **本对话内允许**。它只覆盖该对话中的这个确切工具；可以在标题栏的标签中撤销它。

**如何在 dsh 侧边栏中只显示我今天用过的项目？** 侧边栏 → 视图选项（滑块图标）→ **最近 2 小时内活跃**。再次选择该项即可显示所有项目。

**如何在 dsh 中复制项目的文件夹路径？** 在侧边栏中右键点击项目 → **复制路径**。

**如何一次折叠 dsh 侧边栏中的所有项目？** 点击视图选项（滑块图标）旁边的折叠按钮。至少有一个项目展开时，这个按钮才会显示。

**dsh 任务完成或需要审批时，如何收到 macOS / Windows 通知？** 保持 **后台通知** 开启（默认开启），并在操作系统设置中允许 DeepSeek Harness 发送通知。

**如何把 DeepSeek Harness 界面切换为土耳其语、西班牙语、日语……？** 设置 → Composer Plus → **应用语言**。

**如何在 iPhone 上使用 dsh？** 用 Xcode 从 `tether/ios` 构建 Tether 应用，开启 **设置 → Composer Plus → 手机连接（iPhone）**，点击左下角的 **手机连接**，扫描二维码（用 iPhone 相机或 Tether 中的 **Scan code**），轻点 **Connect**，然后点击 **Approve**。不在家时，请在两台设备上都使用 Tailscale。

**它支持桌面应用吗？** 支持：设置 → 插件 → **添加插件** → `dsh-composer-plus`。已在 dsh 0.2.0-rc.2（桌面版和网页版）和 0.2.1-rc.2（网页版）上测试。

## 开发

截图从一个临时 dsh 重新生成，这个 dsh 使用假模型和虚构的演示项目（`acme-web`、`weather-cli`、`docs-site`），因此截图中没有任何真实数据。功能缩略图放在 `assets/features/` 中（随包发布，在设置中显示）；只用于 README 的图片放在 `docs/images/` 中（不在 npm 包中）：

```sh
PLAYWRIGHT=/path/to/playwright node scripts/capture-screenshots.mjs /path/to/dsh/lib/bin.js
# sidebar project features (recent filter, Copy path, Collapse all): real-app test + their thumbnails
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-sidebar-projects.mjs /path/to/dsh/lib/bin.js
# recent filter + a finished chat older than 2 hours (fake model): the project stays until you open the chat
PLAYWRIGHT=/path/to/playwright node test/browser-recent-finished.mjs /path/to/dsh/lib/bin.js
# Order by status (fake model + Schedule): real-app test + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-status-order.mjs /path/to/dsh/lib/bin.js
# every Settings feature row shows a loading screenshot
PLAYWRIGHT=/path/to/playwright node test/browser-settings-shots.mjs /path/to/dsh/lib/bin.js
# Keep composer focus (fake model + demo skill): typing goes on after a / command + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-keep-focus.mjs /path/to/dsh/lib/bin.js
# Mobile connect: switch on, QR popover, a fake iPhone pairs and calls dsh through the gateway, switch off + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-mobile-connect.mjs /path/to/dsh/lib/bin.js
# Resume after restart (fake slow model, real quit and start): a running chat and a goal continue, a stopped chat does not
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-resume-restart.mjs /path/to/dsh/lib/bin.js
# Feature ideas (fake model, made-up project): suggest, drag left, Undo, ✓ starts a new chat in plan mode, ▶ Build now one without, Plan all one for the Later list, a focus topic chip, Copy as checklist + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-feature-ideas.mjs /path/to/dsh/lib/bin.js
# Export chat as Markdown (fake model, made-up project): right-click → Export as Markdown…, copy and save keep the code blocks, switch off + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-export-markdown.mjs /path/to/dsh/lib/bin.js
# Content search (fake model, made-up chats): a message-only word finds its chat with the snippet, switch off + restart = titles only + its thumbnail
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-content-search.mjs /path/to/dsh/lib/bin.js
# Turn rollback + Delete chat (fake model, made-up git project): bash edit → ↶ Chat and files → files back, .git unchanged; Delete… → Trash + its thumbnails
SHOT=1 PLAYWRIGHT=/path/to/playwright node test/browser-turn-rollback.mjs /path/to/dsh/lib/bin.js
```

```sh
npm run build:locales # after editing locales/<id>.json
npm test
```

**新功能规则：** 设置 → Composer Plus 中的每个功能行都会显示一张截图。把功能 id 添加到 `client.js` 的 `SHOT_OF` 和 `index.js` 的 `SHOTS` 中，并发布 `assets/features/<id>.webp`（从临时演示 dsh 中截取，使用英文界面，大小约 60 kB 或更小）。把该功能添加到 README 表格中，并使用同一张图片：`README.md` 和每个翻译版 `README.<id>.md` 都要添加。功能没有截图时，`test/shots.test.mjs` 会失败；`test/browser-settings-shots.mjs` 会检查真实的设置页面。每次更改的完整检查清单见 [AGENTS.md](AGENTS.md)。

测试会在假的 React/DOM 上运行真实的 `client.js`，并在临时 git 仓库上运行真实的 `index.js`（Host 端）。Tether 网关测试（`test/tether-gateway.test.mjs`）使用模拟的 dsh host 和真实的 TLS 网关。iPhone 应用位于 `tether/ios` 中（见 [tether/README.md](tether/README.md) 和 [tether/AGENTS.md](tether/AGENTS.md)）。`node test/browser-history.mjs '<dsh web URL with ?token=…>'` 会在真实浏览器中，针对一个使用独立 `DSH_HOME` 的临时 `dsh web` 检查输入历史。

语言包是 `locales/<id>.json` 中的纯数据 JSON，由 `npm run build:locales` 嵌入到唯一的客户端入口中（不使用翻译服务，也不在运行时下载）。`npm test` 会检查每个语言包是否覆盖全部键、占位符和换行是否一致，以及跟随系统语言和手动覆盖时的行为。如需在本地安装的 Playwright 中进行隔离的真实应用检查：

```sh
PLAYWRIGHT=/path/to/playwright node test/browser-language.mjs /path/to/dsh/lib/bin.js
```

## License

MIT
