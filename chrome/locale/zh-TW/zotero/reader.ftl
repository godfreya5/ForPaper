pdfReader-underlineText = 底線文字
pdfReader-highlightText = 突顯文字
pdfReader-addText = 新增文字
pdfReader-selectArea = 選擇區域
pdfReader-draw = 繪圖
pdfReader-highlightAnnotation = 凸顯標註
pdfReader-underlineAnnotation = 底線標註
pdfReader-noteAnnotation = Note Annotation
pdfReader-textAnnotation = Text Annotation
pdfReader-imageAnnotation = Image Annotation
pdfReader-find-in-document = 在文件中尋找
pdfReader-move-annotation-start-key =
    { PLATFORM() ->
        [macos] { general-key-command }
       *[other] { general-key-alt }
    }
pdfReader-a11yMoveAnnotation = Use the arrow keys to move the annotation.
pdfReader-a11yEditTextAnnotation = To move the end of the text annotation, hold { general-key-shift } and use the left/right arrow keys. To move the start of the annotation, hold { general-key-shift }-{ pdfReader-move-annotation-start-key } and use the arrow keys.
pdfReader-a11yResizeAnnotation = To resize the annotation, hold { general-key-shift } and use the arrow keys.
pdfReader-a11yAnnotationPopupAppeared = Use Tab to navigate the annotation popup.
pdfReader-a11yAnnotationCreated = { $type } created.
pdfReader-a11yAnnotationSelected = { $type } selected.
-pdfReader-a11yTextualAnnotationInstruction = To annotate text via the keyboard, first use “{ pdfReader-find-in-document }” to locate the phrase, and then press { general-key-control }-{ option-or-alt }-{ $number } to turn the search result into an annotation.
-pdfReader-a11yAnnotationInstruction = To add this annotation into the document, focus the document and press { general-key-control }-{ option-or-alt }-{ $number }.
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
    .aria-description = This annotation type cannot be created via the keyboard.
    .title = { pdfReader-draw }
pdfReader-findInDocumentInput =
    .title = 尋找
    .placeholder = { pdfReader-find-in-document }
    .aria-description = To turn a search result into a highlight annotation, press { general-key-control }-{ option-or-alt }-1. To turn a search result into an underline annotation, press { general-key-control }-{ option-or-alt }-2.
pdfReader-import-from-epub =
    .label = Import Ebook Annotations…
pdfReader-import-from-epub-prompt-title = Import Ebook Annotations
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
pdfReader-import-from-epub-select-other = 選擇其他檔案…

reader-annotations = 註釋
reader-show-annotations = 顯示註釋
reader-search-annotations = 搜尋註釋
reader-search-outline = 搜尋大綱
reader-no-annotations = 建立註釋以在側邊欄中檢視
reader-no-extracted-text = 無提取的文本
reader-add-comment = 新增評論
reader-annotation-comment = 註釋評論
reader-annotation-text = 註釋文本
reader-manage-tags = 管理此註釋的標籤
reader-open-menu = 開啟註釋選單
reader-thumbnails = 縮圖
reader-tag-selector-message = 按此標籤篩選註釋
reader-add-tags = 新增標籤…
reader-highlight-text = 標明文本
reader-underline-text = 底線文本
reader-add-note = 新增註記
reader-add-text = 新增文本
reader-select-area = 選擇區域
reader-highlight-annotation = 標明註釋
reader-underline-annotation = 底線註釋
reader-note-annotation = 註記註釋
reader-text-annotation = 文本註釋
reader-image-annotation = 影像註釋
reader-ink-annotation = 筆跡註釋
reader-card-annotation = 卡片註釋
reader-search-result-index = 搜尋結果
reader-search-result-total = 總搜尋結果
reader-draw = 繪圖
reader-eraser = 橡皮擦
reader-pick-color = 選擇顏色
reader-add-to-note = 新增至註記
reader-zoom-in = 放大
reader-zoom-out = 縮小
reader-zoom-reset = 重設縮放
reader-zoom-auto = 自動調整大小
reader-zoom-page-width = 縮放至頁面寬度
reader-zoom-page-height = 縮放至頁面高度
reader-split-vertically = 縱向分割
reader-split-horizontally = 橫向分割
reader-next-page = 下一頁
reader-previous-page = 上一頁
reader-page = 頁面
reader-location = 位置
reader-read-only = 唯讀
reader-prompt-transfer-from-pdf-title = 匯入註釋
reader-prompt-transfer-from-pdf-text = 儲存在 PDF 檔案中的註釋將移動到 { $target }。
reader-prompt-password-protected = 密碼保護的 PDF 檔案不支援此操作。
reader-prompt-delete-pages-title = 刪除頁面
reader-prompt-delete-pages-text =
    { $count ->
        [one] 是否確實要從 PDF 檔案中刪除 { $count } 頁？
        *[other] 是否確實要從 PDF 檔案中刪除 { $count } 頁？
    }
reader-prompt-delete-annotations-title = 刪除註釋
reader-prompt-delete-annotations-text =
    { $count ->
        [one] 是否確實要刪除所選的註釋？
        *[other] 是否確實要刪除所選的註釋？
    }
reader-rotate-left = 左轉
reader-rotate-right = 右轉
reader-edit-page-number = 編輯頁碼…
reader-edit-annotation-text = 編輯註釋文本
reader-copy-image = 複製影像
reader-save-image-as = 影像另存為…
reader-page-number-popup-header = 更改以下頁碼：
reader-this-annotation = 此註釋
reader-selected-annotations = 所選的註釋
reader-this-page = 此頁面
reader-this-page-and-later-pages = 此頁面及之後的頁面
reader-all-pages = 所有頁面
reader-auto-detect = 自動偵測
reader-enter-password = 輸入密碼以開啟此 PDF 檔案
reader-include-annotations = 包含註釋
reader-preparing-document-for-printing = 準備列印文件…
reader-phrase-not-found = 未找到短語
reader-find = 尋找
reader-close = 關閉
reader-show-thumbnails = 顯示縮圖
reader-show-outline = 顯示大綱
reader-find-previous = 尋找短語的上一個符合項
reader-find-next = 尋找短語的下一個符合項
reader-toggle-sidebar = 切換側邊欄
reader-find-in-document = 在文件中尋找
reader-toggle-context-pane = 切換上下文窗格
reader-highlight-all = 全部標明
reader-match-case = 區分大小寫
reader-whole-words = 整個單字
reader-appearance = 外觀
reader-epub-appearance-line-height = 行高
reader-epub-appearance-word-spacing = 字詞間距
reader-epub-appearance-letter-spacing = 字母間距
reader-epub-appearance-page-width = 頁面寬度
reader-epub-appearance-use-original-font = 使用原始字體
reader-epub-appearance-line-height-revert = 使用預設行高
reader-epub-appearance-word-spacing-revert = 使用預設字詞間距
reader-epub-appearance-letter-spacing-revert = 使用預設字母間距
reader-epub-appearance-page-width-revert = 使用預設頁面寬度
reader-convert-to-highlight = 轉換為標明
reader-convert-to-underline = 轉換為底線
reader-size = 大小
reader-merge = 合併
reader-copy-link = 複製連結
reader-theme-original = 原始
reader-theme-snow = 雪
reader-theme-sepia = 棕褐色
reader-theme-dark = 深色
reader-add-theme = 新增主題
reader-scroll-mode = 滾動
reader-spread-mode = 展開
reader-flow-mode = 頁面配置
reader-columns = 欄
reader-split-view = 分割檢視
reader-themes = 主題
reader-vertical = 縱向
reader-horizontal = 橫向
reader-wrapped = 環繞
reader-none = 無
reader-odd = 奇數
reader-even = 偶數
reader-paginated = 分頁
reader-scrolled = 滾動
reader-single = 單欄
reader-double = 雙欄
reader-theme-name = 主題名稱：
reader-background = 背景：
reader-foreground = 前景：
reader-focus-mode = 焦點模式
reader-clear-selection = 清除選取項

reader-general-cancel = 取消
reader-general-save = 儲存
reader-general-copy = 複製
reader-general-edit = 編輯
reader-general-delete = 刪除
reader-general-saving = 儲存中...
reader-general-cancelled = 已取消
reader-general-complete = 完成

reader-flashcard-title = 閃卡
reader-flashcard-edit-title = 編輯閃卡
reader-flashcard-delete-confirm = 刪除此閃卡？
reader-flashcard-question-view = 問題 Q
reader-flashcard-answer-view = 答案 A
reader-flashcard-question-label = 問題
reader-flashcard-answer-label = 答案
reader-flashcard-question-placeholder = 輸入問題...
reader-flashcard-answer-placeholder = 輸入答案...
reader-flashcard-no-question = 尚無問題
reader-flashcard-no-answer = 尚無答案

reader-summarycard-edit-title = 編輯摘要卡
reader-summarycard-delete-confirm = 刪除此摘要卡？
reader-summarycard-edit-zoom-blocked = 目前有 SummaryCard 正在編輯，請先儲存或取消後再縮放
reader-summarycard-copy-summary = 複製段落摘要
reader-summarycard-copy-translation = 複製原文翻譯
reader-summarycard-title-label = 標題翻譯
reader-summarycard-paragraph-label = 段落摘要
reader-summarycard-points-label = 要點
reader-summarycard-title-placeholder = 編輯標題翻譯...
reader-summarycard-paragraph-placeholder = 段落摘要...
reader-summarycard-point-placeholder = 要點...
reader-summarycard-merge-next-point = 與下一要點合併
reader-summarycard-title-input-placeholder = 輸入標題翻譯...
reader-summarycard-paragraph-input-placeholder = 輸入段落摘要...
reader-summarycard-point-input-placeholder = 輸入要點...
