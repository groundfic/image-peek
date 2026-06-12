import {
	App,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
} from "obsidian";

interface QuickPeekSettings {
	dblclickToOpen: boolean;
	spaceToOpen: boolean;
	showActions: boolean;
	backdropBlur: boolean;
	/** 符合這些 CSS 選擇器的容器內的圖片不觸發預覽（逗號分隔） */
	excludeSelectors: string;
}

const DEFAULT_SETTINGS: QuickPeekSettings = {
	dblclickToOpen: true,
	spaceToOpen: true,
	showActions: true,
	backdropBlur: true,
	excludeSelectors: '[class*="lcp-"]',
};

interface ResolvedImage {
	src: string;
	title: string;
	vaultPath: string | null;
}

/** 圖片允許出現的容器（筆記閱讀模式、Live Preview、Canvas、hover 預覽） */
const CONTAINER_SELECTOR =
	".markdown-reading-view, .markdown-source-view, .canvas-wrapper, .popover.hover-popover";

export default class QuickPeekPlugin extends Plugin {
	settings: QuickPeekSettings = DEFAULT_SETTINGS;
	private overlay: PeekOverlay | null = null;
	private hoveredImg: HTMLImageElement | null = null;
	private downPos: { x: number; y: number } | null = null;
	private downTime = 0;
	/** 觸控雙點偵測 */
	private lastTap: { img: HTMLImageElement | null; time: number } = {
		img: null,
		time: 0,
	};

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new QuickPeekSettingTab(this.app, this));

		// 追蹤目前懸停的圖片（給 Space 觸發用）
		this.registerDomEvent(document, "mouseover", (evt) => {
			const img = this.previewableImg(evt.target);
			if (img) this.hoveredImg = img;
		});
		this.registerDomEvent(document, "mouseout", (evt) => {
			if (evt.target === this.hoveredImg) this.hoveredImg = null;
		});

		// 記錄按下位置，用來區分「點」與「拖曳」
		this.registerDomEvent(
			document,
			"pointerdown",
			(evt) => {
				this.downPos = { x: evt.clientX, y: evt.clientY };
				this.downTime = Date.now();
			},
			{ capture: true }
		);

		// 桌面：雙擊開啟
		this.registerDomEvent(document, "dblclick", this.onDblClick, {
			capture: true,
		});
		// 觸控：雙點開啟（行動版的 dblclick 不可靠，自己偵測）
		this.registerDomEvent(document, "pointerup", this.onPointerUp, {
			capture: true,
		});

		this.registerDomEvent(window, "keydown", this.onKeyDown, {
			capture: true,
		});

		this.addCommand({
			id: "peek-image",
			name: "Preview hovered or selected image",
			callback: () => {
				const img = this.hoveredImg ?? this.focusedCanvasImg();
				if (img) this.open(img);
			},
		});
	}

	onunload() {
		this.overlay?.destroy();
	}

	// ---------- 事件 ----------

	private onDblClick = (evt: MouseEvent) => {
		if (!this.settings.dblclickToOpen || this.overlay) return;
		if (evt.defaultPrevented || evt.button !== 0) return;
		// 保留 Obsidian 原生的修飾鍵行為
		if (evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;

		const img = this.previewableImg(evt.target);
		if (!img) return;

		evt.preventDefault();
		evt.stopPropagation();
		this.open(img);
	};

	private onPointerUp = (evt: PointerEvent) => {
		if (evt.pointerType === "mouse") return;
		if (!this.settings.dblclickToOpen || this.overlay) return;

		const img = this.previewableImg(evt.target);
		if (!img) {
			this.lastTap.img = null;
			return;
		}
		// 拖曳不算點
		if (this.downPos) {
			const dx = evt.clientX - this.downPos.x;
			const dy = evt.clientY - this.downPos.y;
			if (dx * dx + dy * dy > 100) {
				this.lastTap.img = null;
				return;
			}
		}
		// 長按不算點（保留 Obsidian 的長按選單）
		if (this.downTime && Date.now() - this.downTime > 450) {
			this.lastTap.img = null;
			return;
		}

		// 筆記內：單點直接開啟；Canvas：維持雙點（單點留給選取節點）
		const inCanvas = !!img.closest(".canvas-wrapper, .canvas-node");
		if (!inCanvas) {
			evt.preventDefault();
			evt.stopPropagation();
			this.open(img);
			return;
		}

		const now = Date.now();
		if (this.lastTap.img === img && now - this.lastTap.time < 350) {
			this.lastTap = { img: null, time: 0 };
			evt.preventDefault();
			evt.stopPropagation();
			this.open(img);
		} else {
			this.lastTap = { img, time: now };
		}
	};

	private onKeyDown = (evt: KeyboardEvent) => {
		// 覆層開啟中：Space / Esc 關閉，← → 導覽
		if (this.overlay) {
			if (
				evt.code === "Space" ||
				evt.key === "Escape" ||
				evt.key === "ArrowLeft" ||
				evt.key === "ArrowRight"
			) {
				evt.preventDefault();
				evt.stopPropagation();
				if (evt.code === "Space" || evt.key === "Escape") {
					this.overlay.close();
				} else {
					this.overlay.navigate(evt.key === "ArrowRight" ? 1 : -1);
				}
			}
			return;
		}

		if (!this.settings.spaceToOpen || evt.code !== "Space") return;
		if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
		// 正在輸入文字時不攔截空白鍵
		if (this.isEditingContext()) return;

		const img = this.hoveredImg ?? this.focusedCanvasImg();
		if (!img || !img.isConnected) return;

		evt.preventDefault();
		evt.stopPropagation();
		this.open(img);
	};

	private isEditingContext(): boolean {
		const el = document.activeElement as HTMLElement | null;
		if (!el) return false;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
			return true;
		return el.isContentEditable || !!el.closest(".cm-editor");
	}

	/** Canvas 中被選取（focused）的圖片節點，模仿無邊記「選取後按 Space」 */
	private focusedCanvasImg(): HTMLImageElement | null {
		const img = document.querySelector<HTMLImageElement>(
			".canvas-node.is-focused .canvas-node-content img"
		);
		// 一樣要通過完整檢查（排除選擇器、vault 圖檔限制），
		// 否則選到連結卡片節點按 Space 會誤開卡片裡的圖
		return img ? this.previewableImg(img) : null;
	}

	private previewableImg(target: EventTarget | null): HTMLImageElement | null {
		if (!(target instanceof HTMLImageElement)) return null;
		if (target.closest(".image-peek-overlay")) return null;
		// 不攔截超連結內的圖片
		if (target.closest("a")) return null;
		// 不攔截其他外掛的元件（例如連結卡片的預覽圖）
		const exclude = this.settings.excludeSelectors?.trim();
		if (exclude) {
			try {
				if (target.closest(exclude)) return null;
			} catch {
				// 選擇器寫錯就略過，不要讓整個外掛掛掉
			}
		}
		if (!target.closest(CONTAINER_SELECTOR)) return null;
		if (target.naturalWidth === 0) return null;
		// Canvas 上只預覽 vault 內的圖片檔（app:// 資源）。
		// 連結卡片類外掛的圖片是 base64 或外部網址，一律放行不攔截。
		if (target.closest(".canvas-wrapper, .canvas-node")) {
			const src = target.currentSrc || target.src;
			if (!src.startsWith("app:")) return null;
		}
		return target;
	}

	// ---------- 開啟 ----------

	open(img: HTMLImageElement) {
		this.overlay?.destroy();

		// 收集同一個視圖內的所有圖片，給 ← → 導覽
		const root = img.closest(CONTAINER_SELECTOR) ?? document.body;
		const list = Array.from(root.querySelectorAll("img")).filter(
			(el) => this.previewableImg(el) && el.getBoundingClientRect().width > 0
		) as HTMLImageElement[];
		const index = Math.max(0, list.indexOf(img));

		this.overlay = new PeekOverlay(this, list.length ? list : [img], index);
		this.overlay.onClosed = () => (this.overlay = null);
	}

	/** 從 img 元素反推 vault 內路徑與顯示名稱 */
	resolveImage(img: HTMLImageElement): ResolvedImage {
		const src = img.currentSrc || img.src;

		// 1. 筆記內嵌：<span class="internal-embed" src="圖片.png">
		const embed = img.closest(".internal-embed[src]");
		const link = embed?.getAttribute("src");
		if (link) {
			const clean = decodeURIComponent(link.split("#")[0].split("|")[0]);
			const file = this.app.metadataCache.getFirstLinkpathDest(
				clean,
				this.app.workspace.getActiveFile()?.path ?? ""
			);
			if (file) {
				return {
					src: this.app.vault.getResourcePath(file),
					title: file.name,
					vaultPath: file.path,
				};
			}
		}

		// 2. Canvas 檔案節點：用節點標籤上的檔名反查
		const label = img
			.closest(".canvas-node")
			?.querySelector(".canvas-node-label")
			?.textContent?.trim();
		if (label) {
			const file = this.app.metadataCache.getFirstLinkpathDest(label, "");
			if (file) {
				return {
					src: this.app.vault.getResourcePath(file),
					title: file.name,
					vaultPath: file.path,
				};
			}
		}

		// 3. app:// 資源網址 → 還原成 vault 相對路徑
		try {
			const url = new URL(src);
			if (url.protocol === "app:") {
				let p = decodeURIComponent(url.pathname);
				if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // Windows 磁碟機
				const basePath = (this.app.vault.adapter as any).getBasePath?.();
				if (basePath && p.startsWith(basePath)) {
					const rel = p.slice(basePath.length).replace(/^[/\\]+/, "");
					return {
						src,
						title: rel.split("/").pop() ?? rel,
						vaultPath: rel,
					};
				}
				return { src, title: p.split("/").pop() ?? "圖片", vaultPath: null };
			}
			// 4. 外部圖片
			const name = url.pathname.split("/").pop();
			return { src, title: name || url.hostname, vaultPath: null };
		} catch {
			return { src, title: "Image", vaultPath: null };
		}
	}

	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		// 從舊版設定遷移（clickToOpen → dblclickToOpen）
		if ("clickToOpen" in data && !("dblclickToOpen" in data)) {
			data.dblclickToOpen = data.clickToOpen;
			delete data.clickToOpen;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ---------------------------------------------------------------- Overlay

class PeekOverlay {
	onClosed: (() => void) | null = null;

	private rootEl: HTMLElement;
	private panelEl: HTMLElement;
	private stageEl: HTMLElement;
	private imgEl: HTMLImageElement;
	private titleEl: HTMLElement;
	private counterEl: HTMLElement;
	private actionsEl: HTMLElement;

	private scale = 1;
	private tx = 0;
	private ty = 0;
	private closing = false;

	/** 多點觸控狀態 */
	private pointers = new Map<number, { x: number; y: number }>();
	private lastPinchDist = 0;
	private lastMid: { x: number; y: number } | null = null;
	private panStart: { x: number; y: number; tx: number; ty: number } | null =
		null;
	private tapMoved = false;
	private lastStageTap = 0;

	constructor(
		private plugin: QuickPeekPlugin,
		private list: HTMLImageElement[],
		private index: number
	) {
		const doc = document.body;

		this.rootEl = doc.createDiv({ cls: "image-peek-overlay" });
		if (plugin.settings.backdropBlur) this.rootEl.addClass("qp-blur");

		const backdrop = this.rootEl.createDiv({ cls: "qp-backdrop" });
		backdrop.addEventListener("click", () => this.close());

		this.panelEl = this.rootEl.createDiv({ cls: "qp-panel" });

		// 標題列
		const header = this.panelEl.createDiv({ cls: "qp-header" });
		const closeBtn = header.createDiv({
			cls: "qp-btn qp-close",
			attr: { "aria-label": "Close (Esc / Space)" },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.close());

		this.titleEl = header.createDiv({ cls: "qp-title" });
		this.actionsEl = header.createDiv({ cls: "qp-actions" });

		// 舞台
		this.stageEl = this.panelEl.createDiv({ cls: "qp-stage" });
		this.imgEl = this.stageEl.createEl("img", { cls: "qp-img" });
		this.counterEl = this.panelEl.createDiv({ cls: "qp-counter" });

		this.bindStageEvents();
		this.show(this.index, true);
	}

	// ---------- 顯示某一張 ----------

	private show(index: number, animateFromSource: boolean) {
		this.index = (index + this.list.length) % this.list.length;
		const srcImg = this.list[this.index];
		const info = this.plugin.resolveImage(srcImg);

		this.scale = 1;
		this.tx = 0;
		this.ty = 0;
		this.applyTransform(false);

		this.imgEl.src = info.src;
		this.titleEl.setText(info.title);
		this.counterEl.setText(
			this.list.length > 1 ? `${this.index + 1} / ${this.list.length}` : ""
		);
		this.buildActions(info);

		if (animateFromSource) {
			this.animateIn(srcImg);
		}
	}

	private buildActions(info: ResolvedImage) {
		this.actionsEl.empty();
		if (!this.plugin.settings.showActions) return;

		// 分享（macOS 桌面用系統分享選單；行動端用系統分享面板）
		const canShareDesktop =
			Platform.isDesktop && Platform.isMacOS && !!info.vaultPath;
		const canShareMobile = Platform.isMobile && !!(navigator as any).share;
		if (canShareDesktop || canShareMobile) {
			const shareBtn = this.actionsEl.createDiv({
				cls: "qp-btn",
				attr: { "aria-label": "Share" },
			});
			setIcon(shareBtn, "share");
			shareBtn.addEventListener("click", () =>
				this.shareImage(info, shareBtn)
			);
		}

		// 複製圖片（所有圖片皆可，含外部圖片）
		const copyBtn = this.actionsEl.createDiv({
			cls: "qp-btn",
			attr: { "aria-label": "Copy image" },
		});
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", () => this.copyImage());

		// 以下動作僅 vault 內圖片、桌面版
		if (!info.vaultPath || !Platform.isDesktop) return;

		const app = this.plugin.app as any;
		const openBtn = this.actionsEl.createDiv({
			cls: "qp-btn",
			attr: { "aria-label": "Open in default app" },
		});
		setIcon(openBtn, "external-link");
		openBtn.addEventListener("click", () =>
			app.openWithDefaultApp?.(info.vaultPath)
		);

		const revealBtn = this.actionsEl.createDiv({
			cls: "qp-btn",
			attr: {
				"aria-label": Platform.isMacOS ? "Reveal in Finder" : "Show in file explorer",
			},
		});
		setIcon(revealBtn, "folder");
		revealBtn.addEventListener("click", () =>
			app.showInFolder?.(info.vaultPath)
		);
	}

	/** 叫出系統分享：macOS 桌面 → Apple 分享選單；行動端 → 系統分享面板 */
	private async shareImage(info: ResolvedImage, anchor: HTMLElement) {
		// --- macOS 桌面：Electron 原生 ShareMenu ---
		if (Platform.isDesktop) {
			try {
				if (!Platform.isMacOS || !info.vaultPath)
					throw new Error("此平台不支援系統分享");
				const electron = (window as any).require?.("electron");
				const remote =
					electron?.remote ??
					(window as any).require?.("@electron/remote");
				const ShareMenu =
					remote?.ShareMenu ?? remote?.require?.("electron")?.ShareMenu;
				const basePath = (
					this.plugin.app.vault.adapter as any
				).getBasePath?.();
				if (!ShareMenu || !basePath)
					throw new Error("無法取得系統分享選單");

				const absPath = `${basePath}/${info.vaultPath}`;
				const menu = new ShareMenu({ filePaths: [absPath] });
				const rect = anchor.getBoundingClientRect();
				menu.popup({
					window: remote.getCurrentWindow(),
					x: Math.round(rect.left),
					y: Math.round(rect.bottom + 4),
				});
			} catch (e) {
				console.error("Image Peek share failed", e);
				new Notice("System sharing is not supported on this platform");
			}
			return;
		}

		// --- 行動端：Web Share API（帶圖片檔） ---
		try {
			const resp = await fetch(this.imgEl.src);
			const blob = await resp.blob();
			const type = blob.type || "image/png";
			const ext = (type.split("/")[1] ?? "png").replace("jpeg", "jpg");
			const name = /\.[a-z0-9]+$/i.test(info.title)
				? info.title
				: `${info.title || "image"}.${ext}`;
			const file = new File([blob], name, { type });

			const nav = navigator as any;
			if (nav.canShare?.({ files: [file] })) {
				await nav.share({ files: [file], title: info.title });
			} else if (nav.share) {
				await nav.share({ title: info.title, text: info.title });
			} else {
				throw new Error("不支援 Web Share");
			}
		} catch (e: any) {
			if (e?.name === "AbortError") return; // 使用者自己取消分享
			console.error("Image Peek share failed", e);
			new Notice("Could not share this image");
		}
	}

	/** 複製圖片到剪貼簿（一律轉成 PNG，剪貼簿 API 只收 PNG） */
	private async copyImage() {
		const toPng = (source: CanvasImageSource, w: number, h: number) =>
			new Promise<Blob>((res, rej) => {
				const canvas = document.createElement("canvas");
				canvas.width = w;
				canvas.height = h;
				canvas.getContext("2d")!.drawImage(source, 0, 0);
				canvas.toBlob(
					(b) => (b ? res(b) : rej(new Error("PNG 轉換失敗"))),
					"image/png"
				);
			});

		try {
			let blob: Blob;
			try {
				// 一般情況：直接從已載入的 <img> 畫到 canvas
				if (!this.imgEl.complete || !this.imgEl.naturalWidth)
					throw new Error("圖片尚未載入");
				blob = await toPng(
					this.imgEl,
					this.imgEl.naturalWidth,
					this.imgEl.naturalHeight
				);
			} catch {
				// 跨網域圖片會污染 canvas：改用 fetch 取回再轉
				const resp = await fetch(this.imgEl.src);
				const bitmap = await createImageBitmap(await resp.blob());
				blob = await toPng(bitmap, bitmap.width, bitmap.height);
				bitmap.close();
			}
			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": blob }),
			]);
			new Notice("Image copied");
		} catch (e) {
			console.error("Image Peek copy failed", e);
			new Notice("Could not copy this image");
		}
	}

	navigate(dir: number) {
		if (this.list.length < 2) return;
		this.show(this.index + dir, false);
	}

	// ---------- 動畫 ----------

	/** FLIP：從來源縮圖的位置「長」到定位，模仿 Quick Look */
	private animateIn(srcImg: HTMLImageElement) {
		this.rootEl.addClass("qp-entering");

		const run = () => {
			const from = srcImg.getBoundingClientRect();
			const to = this.imgEl.getBoundingClientRect();
			if (from.width > 0 && to.width > 0) {
				const sx = from.width / to.width;
				const sy = from.height / to.height;
				const dx = from.left + from.width / 2 - (to.left + to.width / 2);
				const dy = from.top + from.height / 2 - (to.top + to.height / 2);
				this.imgEl.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
				this.imgEl.style.opacity = "0.3";
			}
			requestAnimationFrame(() => {
				this.rootEl.removeClass("qp-entering");
				this.rootEl.addClass("qp-open");
				this.imgEl.style.transition =
					"transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease";
				this.imgEl.style.transform = "";
				this.imgEl.style.opacity = "1";
				window.setTimeout(() => {
					this.imgEl.style.transition = "";
				}, 280);
			});
		};

		if (this.imgEl.complete && this.imgEl.naturalWidth > 0) {
			requestAnimationFrame(run);
		} else {
			this.imgEl.addEventListener("load", () => requestAnimationFrame(run), {
				once: true,
			});
			this.imgEl.addEventListener(
				"error",
				() => this.rootEl.addClass("qp-open"),
				{ once: true }
			);
		}
	}

	close() {
		if (this.closing) return;
		this.closing = true;

		// 收回到來源縮圖
		const srcImg = this.list[this.index];
		const from = srcImg?.isConnected ? srcImg.getBoundingClientRect() : null;
		const to = this.imgEl.getBoundingClientRect();

		this.rootEl.removeClass("qp-open");
		this.rootEl.addClass("qp-closing");

		if (from && from.width > 0 && to.width > 0) {
			const sx = from.width / to.width;
			const sy = from.height / to.height;
			const dx = from.left + from.width / 2 - (to.left + to.width / 2);
			const dy = from.top + from.height / 2 - (to.top + to.height / 2);
			this.imgEl.style.transition =
				"transform 200ms cubic-bezier(0.4, 0, 0.6, 1), opacity 180ms ease";
			this.imgEl.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
			this.imgEl.style.opacity = "0";
		}

		window.setTimeout(() => this.destroy(), 210);
	}

	destroy() {
		this.rootEl.remove();
		this.onClosed?.();
	}

	// ---------- 縮放與平移 ----------

	/** 以畫面座標 (px, py) 為中心縮放 factor 倍 */
	private zoomAt(px: number, py: number, factor: number) {
		const rect = this.imgEl.getBoundingClientRect();
		const cx = px - (rect.left + rect.width / 2);
		const cy = py - (rect.top + rect.height / 2);
		const next = Math.min(8, Math.max(0.25, this.scale * factor));
		const applied = next / this.scale;
		this.tx -= cx * (applied - 1);
		this.ty -= cy * (applied - 1);
		this.scale = next;
		this.applyTransform(false);
	}

	private toggleZoom() {
		if (this.scale !== 1 || this.tx || this.ty) {
			this.scale = 1;
			this.tx = 0;
			this.ty = 0;
		} else {
			this.scale = 2;
		}
		this.applyTransform(true);
	}

	private bindStageEvents() {
		// 滾輪縮放（以游標為中心）；trackpad 捏合在 Electron 會轉成 ctrl+wheel，同樣適用
		this.stageEl.addEventListener(
			"wheel",
			(evt: WheelEvent) => {
				evt.preventDefault();
				const speed = evt.ctrlKey ? 0.01 : 0.0022;
				this.zoomAt(evt.clientX, evt.clientY, Math.exp(-evt.deltaY * speed));
			},
			{ passive: false }
		);

		const el = this.stageEl;

		el.addEventListener("pointerdown", (evt: PointerEvent) => {
			if (evt.pointerType === "mouse" && evt.button !== 0) return;
			evt.preventDefault();
			el.setPointerCapture(evt.pointerId);
			this.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

			if (this.pointers.size === 1) {
				this.panStart = {
					x: evt.clientX,
					y: evt.clientY,
					tx: this.tx,
					ty: this.ty,
				};
				this.tapMoved = false;
				this.imgEl.addClass("qp-grabbing");
			} else if (this.pointers.size === 2) {
				// 進入雙指捏合，停止單指平移
				this.panStart = null;
				const [a, b] = [...this.pointers.values()];
				this.lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
				this.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			}
		});

		el.addEventListener("pointermove", (evt: PointerEvent) => {
			if (!this.pointers.has(evt.pointerId)) return;
			this.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

			if (this.pointers.size >= 2) {
				// 雙指：捏合縮放 + 跟隨中點平移
				const [a, b] = [...this.pointers.values()];
				const dist = Math.hypot(a.x - b.x, a.y - b.y);
				const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
				if (this.lastPinchDist > 0 && this.lastMid) {
					this.zoomAt(mid.x, mid.y, dist / this.lastPinchDist);
					this.tx += mid.x - this.lastMid.x;
					this.ty += mid.y - this.lastMid.y;
					this.applyTransform(false);
				}
				this.lastPinchDist = dist;
				this.lastMid = mid;
				this.tapMoved = true;
			} else if (this.panStart) {
				// 單指／滑鼠：平移
				const dx = evt.clientX - this.panStart.x;
				const dy = evt.clientY - this.panStart.y;
				if (dx * dx + dy * dy > 64) this.tapMoved = true;
				this.tx = this.panStart.tx + dx;
				this.ty = this.panStart.ty + dy;
				this.applyTransform(false);
			}
		});

		const endPointer = (evt: PointerEvent) => {
			if (!this.pointers.delete(evt.pointerId)) return;

			if (this.pointers.size < 2) {
				this.lastPinchDist = 0;
				this.lastMid = null;
			}
			if (this.pointers.size === 1) {
				// 捏合結束剩一指：重新錨定平移
				const [p] = [...this.pointers.values()];
				this.panStart = { x: p.x, y: p.y, tx: this.tx, ty: this.ty };
			} else if (this.pointers.size === 0) {
				this.panStart = null;
				this.imgEl.removeClass("qp-grabbing");

				// 觸控雙點：fit ↔ 2x
				if (evt.pointerType !== "mouse" && !this.tapMoved) {
					const now = Date.now();
					if (now - this.lastStageTap < 320) {
						this.toggleZoom();
						this.lastStageTap = 0;
					} else {
						this.lastStageTap = now;
					}
				}
			}
		};
		el.addEventListener("pointerup", endPointer);
		el.addEventListener("pointercancel", endPointer);

		// 滑鼠雙擊：fit ↔ 2x（觸控用上面的雙點偵測，避免重複觸發）
		if (!Platform.isMobile) {
			this.imgEl.addEventListener("dblclick", () => this.toggleZoom());
		}
	}

	private applyTransform(animated: boolean) {
		this.imgEl.style.transition = animated ? "transform 180ms ease" : "";
		this.imgEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
		if (animated) {
			window.setTimeout(() => (this.imgEl.style.transition = ""), 200);
		}
	}
}

// ---------------------------------------------------------------- Settings

class QuickPeekSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: QuickPeekPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Click image to open preview")
			.setDesc("Desktop: double-click to open; single click keeps native behavior. Mobile: single tap in notes, double tap on Canvas (single tap keeps node selection).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.dblclickToOpen).onChange(async (v) => {
					this.plugin.settings.dblclickToOpen = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Space key to open preview")
			.setDesc("Press Space while hovering an image, or with an image node selected on Canvas (never triggers while typing).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.spaceToOpen).onChange(async (v) => {
					this.plugin.settings.spaceToOpen = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show action buttons")
			.setDesc("Show Share, Copy image, Open in default app, and Reveal in Finder buttons in the title bar.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showActions).onChange(async (v) => {
					this.plugin.settings.showActions = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Excluded images (CSS selectors)")
			.setDesc("Images inside containers matching these comma-separated selectors will not trigger the preview. Defaults to excluding Link Card Preview cards.")
			.addText((t) =>
				t
					.setPlaceholder('[class*="lcp-"], .my-widget')
					.setValue(this.plugin.settings.excludeSelectors)
					.onChange(async (v) => {
						this.plugin.settings.excludeSelectors = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Backdrop blur")
			.setDesc("Frosted-glass blur behind the preview. Turn off on lower-powered devices.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.backdropBlur).onChange(async (v) => {
					this.plugin.settings.backdropBlur = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
