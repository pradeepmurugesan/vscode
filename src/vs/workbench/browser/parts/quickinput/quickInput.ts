/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./quickInput';
import { Component } from 'vs/workbench/common/component';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import * as dom from 'vs/base/browser/dom';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { contrastBorder, widgetShadow } from 'vs/platform/theme/common/colorRegistry';
import { SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND } from 'vs/workbench/common/theme';
import { IQuickOpenService, IPickOpenEntry, IPickOptions } from 'vs/platform/quickOpen/common/quickOpen';
import { TPromise } from 'vs/base/common/winjs.base';
import { CancellationToken } from 'vs/base/common/cancellation';
import { QuickInputCheckboxList } from './quickInputCheckboxList';
import { QuickInputBox } from './quickInputBox';
import { KeyCode } from 'vs/base/common/keyCodes';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { CLOSE_ON_FOCUS_LOST_CONFIG } from 'vs/workbench/browser/quickopen';
import { CountBadge } from 'vs/base/browser/ui/countBadge/countBadge';
import { attachBadgeStyler, attachProgressBarStyler, attachButtonStyler } from 'vs/platform/theme/common/styler';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { chain } from 'vs/base/common/event';
import { Button } from 'vs/base/browser/ui/button/button';

const $ = dom.$;

export class QuickInputService extends Component implements IQuickInputService {

	public _serviceBrand: any;

	private static readonly ID = 'workbench.component.quickinput';
	private static readonly MAX_WIDTH = 600;				// Max total width of quick open widget

	private layoutDimensions: dom.Dimension;
	private container: HTMLElement;
	private checkAll: HTMLInputElement;
	private inputBox: QuickInputBox;
	private count: CountBadge;
	private ready = false;
	private progressBar: ProgressBar;
	private checkboxList: QuickInputCheckboxList;
	private ignoreFocusLost = false;

	private resolve: (value?: IPickOpenEntry[] | Thenable<IPickOpenEntry[]>) => void;
	private progress: (value: IPickOpenEntry) => void;

	constructor(
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IPartService private partService: IPartService,
		@IQuickOpenService private quickOpenService: IQuickOpenService,
		@IThemeService themeService: IThemeService
	) {
		super(QuickInputService.ID, themeService);
	}

	private create() {
		if (this.container) {
			return;
		}

		const workbench = document.getElementById(this.partService.getWorkbenchElementId());
		this.container = dom.append(workbench, $('.quick-input-widget'));
		this.container.tabIndex = -1;
		this.container.style.display = 'none';

		const headerContainer = dom.append(this.container, $('.quick-input-header'));

		this.checkAll = <HTMLInputElement>dom.append(headerContainer, $('input.quick-input-check-all'));
		this.checkAll.type = 'checkbox';
		this.toUnbind.push(dom.addStandardDisposableListener(this.checkAll, dom.EventType.CHANGE, e => {
			const checked = this.checkAll.checked;
			this.checkboxList.setAllVisibleChecked(checked);
		}));
		this.toUnbind.push(dom.addDisposableListener(this.checkAll, dom.EventType.CLICK, e => {
			if (e.x || e.y) { // Avoid 'click' triggered by 'space'...
				this.inputBox.setFocus();
			}
		}));

		const filterContainer = dom.append(headerContainer, $('.quick-input-filter'));

		this.inputBox = new QuickInputBox(filterContainer);
		this.toUnbind.push(this.inputBox);
		this.inputBox.onDidChange(value => {
			this.checkboxList.filter(value);
		});
		this.toUnbind.push(this.inputBox.onKeyDown(event => {
			switch (event.keyCode) {
				case KeyCode.DownArrow:
					this.checkboxList.focus('First');
					this.checkboxList.domFocus();
					break;
				case KeyCode.UpArrow:
					this.checkboxList.focus('Last');
					this.checkboxList.domFocus();
					break;
			}
		}));

		const badgeContainer = dom.append(filterContainer, $('.quick-input-count'));
		this.count = new CountBadge(badgeContainer, { countFormat: localize('quickInput.countSelected', "{0} Selected") });
		this.toUnbind.push(attachBadgeStyler(this.count, this.themeService));

		const okContainer = dom.append(headerContainer, $('.quick-input-action'));
		const ok = new Button(okContainer);
		attachButtonStyler(ok, this.themeService);
		ok.label = localize('ok', "OK");
		this.toUnbind.push(ok.onDidClick(e => {
			if (this.ready) {
				this.close(this.checkboxList.getCheckedElements());
			}
		}));

		this.progressBar = new ProgressBar(this.container);
		dom.addClass(this.progressBar.getContainer(), 'quick-input-progress');
		this.toUnbind.push(attachProgressBarStyler(this.progressBar, this.themeService));

		this.checkboxList = this.instantiationService.createInstance(QuickInputCheckboxList, this.container);
		this.toUnbind.push(this.checkboxList);
		this.toUnbind.push(this.checkboxList.onAllVisibleCheckedChanged(checked => {
			this.checkAll.checked = checked;
		}));
		this.toUnbind.push(this.checkboxList.onCheckedCountChanged(count => {
			this.count.setCount(count);
		}));
		this.toUnbind.push(this.checkboxList.onLeave(() => {
			// Defer to avoid the input field reacting to the triggering key.
			setTimeout(() => {
				this.inputBox.setFocus();
				this.checkboxList.clearFocus();
			}, 0);
		}));
		this.toUnbind.push(
			chain(this.checkboxList.onFocusChange)
				.map(e => e[0])
				.filter(e => !!e)
				.latch()
				.on(e => this.progress && this.progress(e))
		);

		this.toUnbind.push(dom.addDisposableListener(this.container, 'focusout', (e: FocusEvent) => {
			if (e.relatedTarget === this.container) {
				(<HTMLElement>e.target).focus();
				return;
			}
			for (let element = <Element>e.relatedTarget; element; element = element.parentElement) {
				if (element === this.container) {
					return;
				}
			}
			if (!this.ignoreFocusLost && !this.environmentService.args['sticky-quickopen'] && this.configurationService.getValue(CLOSE_ON_FOCUS_LOST_CONFIG)) {
				this.close();
			}
		}));
		this.toUnbind.push(dom.addDisposableListener(this.container, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			switch (event.keyCode) {
				case KeyCode.Enter:
					if (this.ready) {
						dom.EventHelper.stop(e, true);
						this.close(this.checkboxList.getCheckedElements());
					}
					break;
				case KeyCode.Escape:
					dom.EventHelper.stop(e, true);
					this.close();
					break;
				case KeyCode.Tab:
					if (!event.altKey && !event.ctrlKey && !event.metaKey) {
						const inputs = this.container.querySelectorAll('input');
						if (event.shiftKey && event.target === inputs[0]) {
							dom.EventHelper.stop(e, true);
							inputs[inputs.length - 1].focus();
						} else if (!event.shiftKey && event.target === inputs[inputs.length - 1]) {
							dom.EventHelper.stop(e, true);
							inputs[0].focus();
						}
					}
					break;
			}
		}));

		this.toUnbind.push(this.quickOpenService.onShow(() => this.close()));

		this.updateStyles();
	}

	private close(value?: IPickOpenEntry[] | Thenable<IPickOpenEntry[]>) {
		if (this.resolve) {
			this.resolve(value);
		}
		this.container.style.display = 'none';
	}

	pick<T extends IPickOpenEntry>(picks: TPromise<T[]>, options: IPickOptions = {}, token: CancellationToken = CancellationToken.None): TPromise<T[]> {
		this.create();
		this.quickOpenService.close();
		if (this.resolve) {
			this.resolve();
		}

		this.inputBox.value = '';
		this.inputBox.setPlaceholder(options.placeHolder || '');
		this.checkboxList.matchOnDescription = options.matchOnDescription;
		this.checkboxList.matchOnDetail = options.matchOnDetail;
		this.ignoreFocusLost = options.ignoreFocusLost;

		this.progressBar.stop();
		this.ready = false;

		this.checkboxList.setElements([]);
		this.checkAll.checked = this.checkboxList.getAllVisibleChecked();
		this.count.setCount(this.checkboxList.getCheckedCount());

		this.container.style.display = null;
		this.updateLayout();
		this.inputBox.setFocus();

		const result = new TPromise<T[]>((resolve, reject, progress) => {
			this.resolve = resolve;
			this.progress = progress;
		});
		const d = token.onCancellationRequested(() => this.close());
		result.then(() => d.dispose(), () => d.dispose());

		const delay = TPromise.timeout(800);
		delay.then(() => this.progressBar.infinite(), () => { /* ignore */ });

		const wasResolve = this.resolve;
		picks.then(elements => {
			delay.cancel();
			if (this.resolve !== wasResolve) {
				return;
			}

			this.progressBar.stop();
			this.ready = true;

			this.checkboxList.setElements(elements);
			this.checkboxList.filter(this.inputBox.value);
			this.checkAll.checked = this.checkboxList.getAllVisibleChecked();
			this.count.setCount(this.checkboxList.getCheckedCount());

			this.updateLayout();
		}).then(null, reason => this.close(TPromise.wrapError(reason)));

		return result;
	}

	public layout(dimension: dom.Dimension): void {
		this.layoutDimensions = dimension;
		this.updateLayout();
	}

	private updateLayout() {
		if (this.layoutDimensions && this.container) {
			const titlebarOffset = this.partService.getTitleBarOffset();
			this.container.style.top = `${titlebarOffset}px`;

			const style = this.container.style;
			const width = Math.min(this.layoutDimensions.width * 0.62 /* golden cut */, QuickInputService.MAX_WIDTH);
			style.width = width + 'px';
			style.marginLeft = '-' + (width / 2) + 'px';

			this.inputBox.layout();
			this.checkboxList.layout();
		}
	}

	protected updateStyles() {
		const theme = this.themeService.getTheme();
		if (this.inputBox) {
			this.inputBox.style(theme);
		}
		if (this.container) {
			const sideBarBackground = theme.getColor(SIDE_BAR_BACKGROUND);
			this.container.style.backgroundColor = sideBarBackground ? sideBarBackground.toString() : undefined;
			const sideBarForeground = theme.getColor(SIDE_BAR_FOREGROUND);
			this.container.style.color = sideBarForeground ? sideBarForeground.toString() : undefined;
			const contrastBorderColor = theme.getColor(contrastBorder);
			this.container.style.border = contrastBorderColor ? `1px solid ${contrastBorderColor}` : undefined;
			const widgetShadowColor = theme.getColor(widgetShadow);
			this.container.style.boxShadow = widgetShadowColor ? `0 5px 8px ${widgetShadowColor}` : undefined;
		}
	}
}
