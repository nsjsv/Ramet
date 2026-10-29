// 补丁版 @milkdown/plugin-slash 7.22.2 的 SlashProvider（源：node_modules/@milkdown/plugin-slash/lib/index.js）。
// slashFactory / 插件本体不补丁，继续从 @milkdown/kit 引入；只有 Provider 类被替换。
// 升级版本后需重新生成并核对这个补丁：
//   1) isSame 语义修正：官方 `isSame = prevState.doc.eq(doc) && selection.eq` 对比的是「最后一次
//      provider.update 调用的 prevState」，而 update 走 lodash debounce（最新参数覆盖），任何
//      doc/selection 都没变的事务（collab ack、PM selection 同步等）排在文档事务之后时，会把
//      真正该求值的那次调用顶掉 → 定时器触发时 isSame=true → 更新被吞。症状：中文 IME 提交
//      "/" 后 slash 菜单不弹（最后一次文档事务在 composition 期间，结束后只剩 no-op 事务）。
//      改为对比「上次真正求值时的 state」（#evaluated）；composing 期间的调用跳过求值、不更新
//      #evaluated，因此 composition 结束后 debounce 触发（或 compositionend 补一次）必然
//      检测到变化。
//   2) 官方 `if (composing || isSame) return` 拆成两步：先 composing 短路，再算 isSame。
import { TextSelection } from "@milkdown/prose/state";
import { findParentNode, posToDOMRect } from "@milkdown/prose";
import { computePosition, flip, offset } from "@floating-ui/dom";
import { debounce } from "lodash-es";

export class SlashProvider {
	#initialized;
	#middleware;
	#floatingUIOptions;
	#root;
	#debounce;
	#trigger;
	#shouldShow;
	#updater;
	#offset;
	/** 上次真正求值（走到 show/hide 判断）时的 editor state；composing 期间不更新 */
	#evaluated;
	constructor(options) {
		this.#initialized = false;
		this.onShow = () => {};
		this.onHide = () => {};
		this.#onUpdate = (view, prevState) => {
			const { state, composing } = view;
			const { ranges } = state.selection;
			const from = Math.min(...ranges.map((range) => range.$from.pos));
			const to = Math.max(...ranges.map((range) => range.$to.pos));
			if (!this.#initialized) {
				(this.#root ?? view.dom.parentElement ?? document.body).appendChild(this.element);
				this.#initialized = true;
			}
			if (composing) return;
			const isSame = this.#evaluated && this.#evaluated.doc.eq(state.doc) && this.#evaluated.selection.eq(state.selection);
			this.#evaluated = state;
			if (isSame) return;
			if (!this.#shouldShow(view, prevState)) {
				this.hide();
				return;
			}
			computePosition({ getBoundingClientRect: () => posToDOMRect(view, from, to) }, this.element, {
				placement: "bottom-start",
				middleware: [
					flip(),
					offset(this.#offset),
					...this.#middleware
				],
				...this.#floatingUIOptions
			}).then(({ x, y }) => {
				Object.assign(this.element.style, {
					left: `${x}px`,
					top: `${y}px`
				});
			}).catch(console.error);
			this.show();
		};
		this.#_shouldShow = (view) => {
			const currentTextBlockContent = this.getContent(view);
			if (!currentTextBlockContent) return false;
			const target = currentTextBlockContent.at(-1);
			if (!target) return false;
			return Array.isArray(this.#trigger) ? this.#trigger.includes(target) : this.#trigger === target;
		};
		this.update = (view, prevState) => {
			this.#updater(view, prevState);
		};
		this.getContent = (view, matchNode = (node) => node.type.name === "paragraph") => {
			const { selection } = view.state;
			const { empty, $from } = selection;
			const isTextBlock = view.state.selection instanceof TextSelection;
			if (typeof document === "undefined") return;
			const isSlashChildren = this.element.contains(document.activeElement);
			const notHasFocus = !view.hasFocus() && !isSlashChildren;
			const isReadonly = !view.editable;
			const isNotInParagraph = !findParentNode(matchNode)(view.state.selection);
			if (notHasFocus || isReadonly || !empty || !isTextBlock || isNotInParagraph) return;
			return $from.parent.textBetween(Math.max(0, $from.parentOffset - 500), $from.parentOffset, void 0, "￼");
		};
		this.destroy = () => {
			this.#updater.cancel();
		};
		this.show = () => {
			this.element.dataset.show = "true";
			this.onShow();
		};
		this.hide = () => {
			this.element.dataset.show = "false";
			this.onHide();
		};
		this.element = options.content;
		this.#debounce = options.debounce ?? 200;
		this.#shouldShow = options.shouldShow ?? this.#_shouldShow;
		this.#trigger = options.trigger ?? "/";
		this.#offset = options.offset;
		this.#middleware = options.middleware ?? [];
		this.#floatingUIOptions = options.floatingUIOptions ?? {};
		this.#root = options.root;
		this.#updater = debounce(this.#onUpdate, this.#debounce);
	}
	#onUpdate;
	#_shouldShow;
}
