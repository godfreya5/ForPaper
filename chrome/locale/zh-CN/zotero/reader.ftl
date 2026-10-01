pdfReader-underlineText = 下划线文本
pdfReader-highlightText = 高亮文本
pdfReader-addText = 新增文字
pdfReader-selectArea = 选择区域
pdfReader-draw = 绘图
pdfReader-highlightAnnotation = 高亮注释
pdfReader-underlineAnnotation = 下划线注释
pdfReader-noteAnnotation = 笔记注释
pdfReader-textAnnotation = 文本注释
pdfReader-imageAnnotation = 图片注释
pdfReader-find-in-document = 在文件中查找
pdfReader-move-annotation-start-key =
    { PLATFORM() ->
        [macos] { general-key-command }
       *[other] { general-key-alt }
    }
pdfReader-a11yMoveAnnotation = 使用方向键移动注释
pdfReader-a11yEditTextAnnotation = To move the end of the text annotation, hold { general-key-shift } and use the left/right arrow keys. To move the start of the annotation, hold { general-key-shift }-{ pdfReader-move-annotation-start-key } and use the arrow keys.
pdfReader-a11yResizeAnnotation = To resize the annotation, hold { general-key-shift } and use the arrow keys.
pdfReader-a11yAnnotationPopupAppeared = 使用 Tab 导航到注释浮窗。
pdfReader-a11yAnnotationCreated = { $type } 已创建.
pdfReader-a11yAnnotationSelected = { $type } 已选择.
-pdfReader-a11yTextualAnnotationInstruction = 要通过键盘标注文本，请先使用“{ pdfReader-find-in-document }”找到该短语，然后按 { general-key-control }-{ option-or-alt }-{ $number } 将搜索结果转为注释中。
-pdfReader-a11yAnnotationInstruction = 要将此注释添加到文档中，请聚焦文档并按 { general-key-control }-{ option-or-alt }-{ $number }。
pdfReader-toolbar-highlight =
    .aria-description = { -pdfReader-a11yTextualAnnotationInstruction(number: 1) }
    .title = { pdfReader-highlightText }
pdfReader-toolbar-underline =
    .aria-description = { -pdfReader-a11yTextualAnnotationInstruction(number: 2) }
    .title = { pdfReader-underlineText }
pdfReader-toolbar-note =
    .aria-description = { -pdfReader-a11yAnnotationInstruction(number: 3) }
    .title = { pdfReader-noteAnnotation }
pdfReader-toolbar-text =
    .aria-description = { -pdfReader-a11yAnnotationInstruction(number: 4) }
    .title = { pdfReader-addText }
pdfReader-toolbar-area =
    .aria-description = { -pdfReader-a11yAnnotationInstruction(number: 5) }
    .title = { pdfReader-selectArea }
pdfReader-toolbar-draw =
    .aria-description = 该注释类型无法通过键盘创建。
    .title = { pdfReader-draw }
pdfReader-findInDocumentInput =
    .title = 查找
    .placeholder = { pdfReader-find-in-document }
    .aria-description = 要将搜索结果转换为高亮注释，请按 { general-key-control }-{ option-or-alt }-1。要将搜索结果转换为下划线注释，请按 { general-key-control }-{ option-or-alt }-2。
pdfReader-import-from-epub =
    .label = 导入电子书注释…
pdfReader-import-from-epub-prompt-title = 导入电子书注释
pdfReader-import-from-epub-prompt-text =
    { -app-name } found { $count ->
        [1] { $count } { $tool } annotation
       *[other] { $count } { $tool } annotations
    }, last edited { $lastModifiedRelative }.
    
    Any { -app-name } annotations that were previously imported from this ebook will be updated.
pdfReader-import-from-epub-no-annotations-current-file =
    This ebook does not appear to contain any importable annotations.
    
    { -app-name } can import ebook annotations created in Calibre and KOReader.
pdfReader-import-from-epub-no-annotations-other-file =
    “{ $filename }” does not appear to contain any Calibre or KOReader annotations.
    
    If this ebook has been annotated with KOReader, try selecting a “metadata.epub.lua” file directly.
pdfReader-import-from-epub-select-other = 选择其他文件…

reader-annotations = 注释
reader-show-annotations = 显示注释
reader-search-annotations = 搜索注释
reader-search-outline = 搜索大纲
reader-no-annotations = 创建注释以在侧边栏中查看
reader-no-extracted-text = 无提取的文本
reader-add-comment = 添加评论
reader-annotation-comment = 注释评论
reader-annotation-text = 注释文本
reader-manage-tags = 管理此注释的标签
reader-open-menu = 打开注释菜单
reader-thumbnails = 缩略图
reader-tag-selector-message = 按此标签筛选注释
reader-add-tags = 添加标签…
reader-highlight-text = 突出显示文本
reader-underline-text = 下划线文本
reader-add-note = 添加笔记
reader-add-text = 添加文本
reader-select-area = 选择区域
reader-highlight-annotation = 突出显示注释
reader-underline-annotation = 下划线注释
reader-note-annotation = 笔记注释
reader-text-annotation = 文本注释
reader-image-annotation = 图像注释
reader-ink-annotation = 墨迹注释
reader-card-annotation = 卡片注释
reader-search-result-index = 搜索结果
reader-search-result-total = 总搜索结果
reader-draw = 绘图
reader-eraser = 橡皮擦
reader-pick-color = 选择颜色
reader-add-to-note = 添加到笔记
reader-zoom-in = 放大
reader-zoom-out = 缩小
reader-zoom-reset = 重置缩放
reader-zoom-auto = 自动调整大小
reader-zoom-page-width = 缩放至页面宽度
reader-zoom-page-height = 缩放至页面高度
reader-split-vertically = 竖直分割
reader-split-horizontally = 水平分割
reader-next-page = 下一页
reader-previous-page = 上一页
reader-page = 页面
reader-location = 位置
reader-read-only = 只读
reader-prompt-transfer-from-pdf-title = 导入注释
reader-prompt-transfer-from-pdf-text = 存储在 PDF 文件中的注释将移动到 { $target }。
reader-prompt-password-protected = 密码保护的 PDF 文件不支持此操作。
reader-prompt-delete-pages-title = 删除页面
reader-prompt-delete-pages-text =
    { $count ->
        [one] 是否确实要从 PDF 文件中删除 { $count } 页？
        *[other] 是否确实要从 PDF 文件中删除 { $count } 页？
    }
reader-prompt-delete-annotations-title = 删除注释
reader-prompt-delete-annotations-text =
    { $count ->
        [one] 是否确实要删除所选注释？
        *[other] 是否确实要删除所选注释？
    }
reader-rotate-left = 左旋转
reader-rotate-right = 右旋转
reader-edit-page-number = 编辑页码…
reader-edit-annotation-text = 编辑注释文本
reader-copy-image = 复制图像
reader-save-image-as = 图像另存为…
reader-page-number-popup-header = 更改以下页码：
reader-this-annotation = 此注释
reader-selected-annotations = 所选注释
reader-this-page = 此页面
reader-this-page-and-later-pages = 此页面及之后的页面
reader-all-pages = 所有页面
reader-auto-detect = 自动检测
reader-enter-password = 输入密码以打开此 PDF 文件
reader-include-annotations = 包含注释
reader-preparing-document-for-printing = 准备文档以供打印…
reader-phrase-not-found = 未找到短语
reader-find = 查找
reader-close = 关闭
reader-show-thumbnails = 显示缩略图
reader-show-outline = 显示大纲
reader-find-previous = 查找短语的上一个匹配项
reader-find-next = 查找短语的下一个匹配项
reader-toggle-sidebar = 切换侧边栏
reader-find-in-document = 在文档中查找
reader-toggle-context-pane = 切换上下文窗格
reader-highlight-all = 全部突出显示
reader-match-case = 区分大小写
reader-whole-words = 整个单词
reader-appearance = 外观
reader-epub-appearance-line-height = 行高
reader-epub-appearance-word-spacing = 字词间距
reader-epub-appearance-letter-spacing = 字母间距
reader-epub-appearance-page-width = 页面宽度
reader-epub-appearance-use-original-font = 使用原始字体
reader-epub-appearance-line-height-revert = 使用默认行高
reader-epub-appearance-word-spacing-revert = 使用默认字词间距
reader-epub-appearance-letter-spacing-revert = 使用默认字母间距
reader-epub-appearance-page-width-revert = 使用默认页面宽度
reader-convert-to-highlight = 转换为突出显示
reader-convert-to-underline = 转换为下划线
reader-size = 大小
reader-merge = 合并
reader-copy-link = 复制链接
reader-theme-original = 原始
reader-theme-snow = 雪
reader-theme-sepia = 棕褐色
reader-theme-dark = 深色
reader-add-theme = 添加主题
reader-scroll-mode = 滚动
reader-spread-mode = 展开
reader-flow-mode = 页面布局
reader-columns = 列
reader-split-view = 分割视图
reader-themes = 主题
reader-vertical = 竖直
reader-horizontal = 水平
reader-wrapped = 环绕
reader-none = 无
reader-odd = 奇数
reader-even = 偶数
reader-paginated = 分页
reader-scrolled = 滚动
reader-single = 单列
reader-double = 双列
reader-theme-name = 主题名称：
reader-background = 背景：
reader-foreground = 前景：
reader-focus-mode = 焦点模式
reader-clear-selection = 清除选择

reader-general-cancel = 取消
reader-general-save = 保存
reader-general-copy = 复制
reader-general-edit = 编辑
reader-general-delete = 删除
reader-general-saving = 保存中...
reader-general-cancelled = 已取消
reader-general-complete = 完成

reader-flashcard-title = 闪卡
reader-flashcard-edit-title = 编辑闪卡
reader-flashcard-delete-confirm = 删除此闪卡？
reader-flashcard-question-view = 问题 Q
reader-flashcard-answer-view = 答案 A
reader-flashcard-question-label = 问题
reader-flashcard-answer-label = 答案
reader-flashcard-question-placeholder = 输入问题...
reader-flashcard-answer-placeholder = 输入答案...
reader-flashcard-no-question = 暂无问题
reader-flashcard-no-answer = 暂无答案

reader-summarycard-edit-title = 编辑摘要卡
reader-summarycard-delete-confirm = 删除此摘要卡？
reader-summarycard-edit-zoom-blocked = 当前有 SummaryCard 正在编辑，请先保存/取消后再缩放
reader-summarycard-copy-summary = 复制段落总结
reader-summarycard-copy-translation = 复制原文翻译
reader-summarycard-title-label = 标题翻译
reader-summarycard-paragraph-label = 段落摘要
reader-summarycard-points-label = 要点
reader-summarycard-title-placeholder = 编辑标题翻译...
reader-summarycard-paragraph-placeholder = 段落摘要...
reader-summarycard-point-placeholder = 要点...
reader-summarycard-merge-next-point = 与下一要点合并
reader-summarycard-title-input-placeholder = 输入标题翻译...
reader-summarycard-paragraph-input-placeholder = 输入段落摘要...
reader-summarycard-point-input-placeholder = 输入要点...
