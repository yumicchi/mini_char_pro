import {
    bindEventHandlers,
    buildThemeVariableCss,
    buildEventList,
    collectThemeVariables,
    findLatestAssistantMessage,
    formatLatestAssistantMessage,
    getLauncherTargets,
    getTextareaRowCount,
    normalizeFloatingPosition,
    readBooleanSetting,
    readGenerationState,
    sendDraftToSillyTavern,
    shouldClosePipWindow,
    triggerRegenerate,
    writeBooleanSetting,
} from './core.js';
import {
    DEFAULT_DESKTOP_BRIDGE_SETTINGS,
    DESKTOP_BRIDGE_SETTINGS_KEY,
    DesktopBridge,
    getDesktopBridgeStatusText,
    normalizeDesktopBridgeSettings,
    parseDesktopBridgeConfiguration,
} from './desktop-bridge.js';

const EXTENSION_NAME = 'pip-mini-chat';
const EXTENSION_VERSION = '1.5.0';
const PIP_WIDTH = 380;
const PIP_HEIGHT = 360;
const LAUNCHER_RETRY_LIMIT = 20;
const FLOATING_POSITION_KEY = 'pip-mini-chat-floating-position';
const COMPATIBLE_SEND_MODE_KEY = 'pip-mini-chat-compatible-send-mode';
const APPEARANCE_SETTINGS_KEY = 'pip-mini-chat-appearance-settings';
const FLOATING_DRAG_MARGIN = 8;
const FONT_FAMILIES = Object.freeze({
    system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    sans: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
    serif: '"Songti SC", SimSun, "Noto Serif CJK SC", serif',
    kai: 'KaiTi, STKaiti, "Noto Serif CJK SC", serif',
    mono: 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace',
});
const DEFAULT_APPEARANCE_SETTINGS = Object.freeze({
    useThemeBackground: true,
    backgroundColor: '#171717',
    backgroundOpacity: 1,
    fontFamily: 'system',
    fontSize: 14,
    textOpacity: 1,
    stealthMode: false,
});

let pipWindow = null;
let pipElements = null;
let sendTextareaMessage = null;
let sillyTavernIsGenerating = null;
let isGenerating = false;
let cleanupPipEventListeners = null;
let launcherRetryCount = 0;
let launcherRetryTimer = null;
let lastRenderedOutputHtml = '';
let desktopBridge = null;
let desktopBridgeStatus = {
    state: 'disabled',
    detail: '',
};
let desktopMutationObserver = null;
let desktopObservedChat = null;
let desktopSyncHeartbeatTimer = null;
let lastDesktopChatSignature = '';
let desktopComposerSyncTimer = null;
let desktopComposerInputListenerInstalled = false;
let applyingDesktopComposerUpdate = false;
let lastDesktopComposerText = '';
let compatibleSendMode = readBooleanSetting({
    storage: globalThis.localStorage,
    key: COMPATIBLE_SEND_MODE_KEY,
    fallback: false,
});
let appearanceSettings = readAppearanceSettings();
let desktopBridgeSettings = readDesktopBridgeSettings();

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function getEventTypes(context) {
    return context?.eventTypes ?? context?.event_types ?? {};
}

function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.min(Math.max(number, minimum), maximum);
}

function normalizeAppearanceSettings(value = {}) {
    const backgroundColor = /^#[0-9a-f]{6}$/i.test(String(value.backgroundColor ?? ''))
        ? String(value.backgroundColor)
        : DEFAULT_APPEARANCE_SETTINGS.backgroundColor;
    const fontFamily = Object.hasOwn(FONT_FAMILIES, value.fontFamily)
        ? value.fontFamily
        : DEFAULT_APPEARANCE_SETTINGS.fontFamily;

    return {
        useThemeBackground: typeof value.useThemeBackground === 'boolean'
            ? value.useThemeBackground
            : DEFAULT_APPEARANCE_SETTINGS.useThemeBackground,
        backgroundColor,
        backgroundOpacity: clampNumber(value.backgroundOpacity, 0, 1, DEFAULT_APPEARANCE_SETTINGS.backgroundOpacity),
        fontFamily,
        fontSize: clampNumber(value.fontSize, 10, 24, DEFAULT_APPEARANCE_SETTINGS.fontSize),
        textOpacity: clampNumber(value.textOpacity, 0.1, 1, DEFAULT_APPEARANCE_SETTINGS.textOpacity),
        stealthMode: typeof value.stealthMode === 'boolean'
            ? value.stealthMode
            : DEFAULT_APPEARANCE_SETTINGS.stealthMode,
    };
}

function readAppearanceSettings() {
    try {
        const raw = globalThis.localStorage?.getItem?.(APPEARANCE_SETTINGS_KEY);
        return normalizeAppearanceSettings(raw ? JSON.parse(raw) : DEFAULT_APPEARANCE_SETTINGS);
    } catch {
        return { ...DEFAULT_APPEARANCE_SETTINGS };
    }
}

function writeAppearanceSettings() {
    try {
        globalThis.localStorage?.setItem?.(APPEARANCE_SETTINGS_KEY, JSON.stringify(appearanceSettings));
    } catch {
        // Appearance persistence is optional when storage is unavailable.
    }
}

function readDesktopBridgeSettings() {
    try {
        const raw = globalThis.localStorage?.getItem?.(DESKTOP_BRIDGE_SETTINGS_KEY);
        return normalizeDesktopBridgeSettings(
            raw ? JSON.parse(raw) : DEFAULT_DESKTOP_BRIDGE_SETTINGS,
        );
    } catch {
        return { ...DEFAULT_DESKTOP_BRIDGE_SETTINGS };
    }
}

function writeDesktopBridgeSettings() {
    try {
        globalThis.localStorage?.setItem?.(
            DESKTOP_BRIDGE_SETTINGS_KEY,
            JSON.stringify(desktopBridgeSettings),
        );
    } catch {
        // Desktop bridge persistence is optional when storage is unavailable.
    }
}

function updateDesktopBridgeSettings(patch) {
    desktopBridgeSettings = normalizeDesktopBridgeSettings({
        ...desktopBridgeSettings,
        ...patch,
    });
    writeDesktopBridgeSettings();
    desktopBridge?.setSettings(desktopBridgeSettings);
    if (desktopBridgeSettings.enabled) {
        registerPipEventListeners();
        installDesktopMutationObserver();
    }
    syncDesktopBridgeSettingsPanel();
}

function updateAppearanceSettings(patch) {
    appearanceSettings = normalizeAppearanceSettings({
        ...appearanceSettings,
        ...patch,
    });
    writeAppearanceSettings();
    applyAppearanceSettings();
    syncAppearanceSettingsPanel();
}

function notifyError(message, error = null) {
    console.error(`[${EXTENSION_NAME}] ${message}`, error ?? '');
    if (globalThis.toastr?.error) {
        globalThis.toastr.error(message, '隐蔽小窗');
    }
    setStatus(message, 'error');
}

function setStatus(text, type = 'idle') {
    if (!pipElements?.status) {
        return;
    }

    pipElements.status.textContent = text;
    pipElements.status.dataset.state = type;
}

function getTitle(context) {
    if (!context) {
        return 'SillyTavern';
    }

    if (context.groupId) {
        const group = context.groups?.find(item => item.id === context.groupId);
        return group?.name ?? 'Group Chat';
    }

    const character = context.characters?.[context.characterId];
    return character?.name
        ?? context.name2
        ?? context.characterName
        ?? 'SillyTavern';
}

function refreshPip() {
    if (!pipElements || pipWindow?.closed) {
        return;
    }

    syncGenerationState();
    const context = getContext();
    const outputHtml = getRenderedLatestAssistantHtml(context) ?? formatLatestAssistantMessage({
        chat: context?.chat,
        formatter: context?.messageFormatting,
    });
    pipElements.title.textContent = getTitle(context);
    if (outputHtml !== lastRenderedOutputHtml) {
        lastRenderedOutputHtml = outputHtml;
        pipElements.output.innerHTML = outputHtml;
        bridgeHostGlobalsToPipWindow();
        executeOutputScripts(pipElements.output);
        updatePipScrollbar();
        pipWindow.setTimeout(updatePipScrollbar, 0);
    }
    updateControls();
}

function updateControls() {
    if (!pipElements) {
        return;
    }

    syncGenerationState();
    const hasText = pipElements.input.value.trim().length > 0;
    pipElements.send.disabled = isGenerating || !hasText;
    pipElements.regenerate.disabled = isGenerating || !getContext()?.chat?.length;
    pipElements.stop.disabled = !isGenerating;

    if (isGenerating) {
        setStatus('Generating', 'generating');
    } else if (pipElements.status.dataset.state !== 'error') {
        setStatus('Idle', 'idle');
    }
}

function writePipInput(text, { append = true } = {}) {
    if (!pipElements?.input) {
        return false;
    }

    const value = String(text ?? '');
    pipElements.input.value = append
        ? `${pipElements.input.value}${value}`
        : value;
    pipElements.input.dispatchEvent(new Event('input', { bubbles: true }));
    pipElements.input.focus();
    return true;
}

async function loadSendTextareaMessage() {
    if (sendTextareaMessage) {
        return sendTextareaMessage;
    }

    const module = await import('/script.js');
    sendTextareaMessage = module.sendTextareaMessage;
    sillyTavernIsGenerating = module.isGenerating;
    return sendTextareaMessage;
}

async function loadSillyTavernStatusHelpers() {
    if (sillyTavernIsGenerating) {
        return;
    }

    try {
        const module = await import('/script.js');
        sillyTavernIsGenerating = module.isGenerating;
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] Could not load SillyTavern status helper`, error);
    }
}

function syncGenerationState() {
    isGenerating = readGenerationState({
        localState: isGenerating,
        isGeneratingFn: sillyTavernIsGenerating,
    });
}

async function sendTextToSillyTavern(text) {
    const sendMessage = await loadSendTextareaMessage();
    const textarea = document.querySelector('#send_textarea');
    const sendButton = compatibleSendMode ? document.querySelector('#send_but') : null;
    await sendDraftToSillyTavern({
        text,
        textarea,
        inputEventFactory: () => new Event('input', { bubbles: true }),
        sendTextareaMessage: sendMessage,
        compatibleIntentTarget: sendButton,
        compatibleIntentEventFactory: createCompatibleSendIntentEvent,
    });
}

async function sendDraft() {
    if (!pipElements) {
        return;
    }

    try {
        await sendTextToSillyTavern(pipElements.input.value);
        pipElements.input.value = '';
        resizePipInput();
        setStatus('Sent', 'idle');
        updateControls();
    } catch (error) {
        notifyError(error?.message ?? 'Send failed', error);
    }
}

function createCompatibleSendIntentEvent() {
    const options = {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        button: 0,
    };

    if (typeof PointerEvent === 'function') {
        return new PointerEvent('pointerup', options);
    }

    return new Event('pointerup', {
        bubbles: true,
        cancelable: true,
    });
}

function stopGeneration() {
    try {
        const context = getContext();
        context?.stopGeneration?.();
    } catch (error) {
        notifyError(error?.message ?? 'Stop failed', error);
    }
}

async function regenerateLastMessage() {
    try {
        isGenerating = true;
        updateControls();
        await triggerRegenerate(getContext());
    } catch (error) {
        isGenerating = false;
        updateControls();
        notifyError(error?.message ?? 'Regenerate failed', error);
    }
}

function getPipStyles() {
    return `
        :root {
            color-scheme: light dark;
            background: transparent;
        }
        * { box-sizing: border-box; }
        html {
            height: 100%;
            overflow: hidden;
        }
        body {
            margin: 0;
            height: 100%;
            overflow: hidden;
            background: transparent;
            color: var(--SmartThemeBodyColor, #f4f4f5);
        }
        .pip-mini-chat {
            display: grid;
            grid-template-rows: auto minmax(0, 1fr) auto auto;
            height: 100vh;
            min-height: 260px;
            overflow: hidden;
            background: color-mix(
                in srgb,
                var(--pip-background-color, var(--SmartThemeBlurTintColor, #171717)) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            color: color-mix(
                in srgb,
                var(--SmartThemeBodyColor, #f4f4f5) var(--pip-text-opacity-percent, 100%),
                transparent
            );
            font-family: var(--pip-font-family, system-ui, sans-serif);
            font-size: var(--pip-font-size, var(--mainFontSize, 14px));
            transition: opacity 0.18s ease;
        }
        .pip-mini-chat[data-stealth-mode="true"] {
            background: transparent;
            opacity: 0;
        }
        .pip-mini-chat[data-stealth-mode="true"]:hover,
        .pip-mini-chat[data-stealth-mode="true"]:focus-within {
            opacity: 1;
        }
        .pip-mini-chat[data-stealth-mode="true"] .pip-mini-chat__header,
        .pip-mini-chat[data-stealth-mode="true"] .pip-mini-chat__input,
        .pip-mini-chat[data-stealth-mode="true"] .pip-mini-chat__actions,
        .pip-mini-chat[data-stealth-mode="true"] .pip-mini-chat__button,
        .pip-mini-chat[data-stealth-mode="true"] .pip-mini-chat__scrollbar,
        .pip-mini-chat[data-stealth-mode="true"] .pip-mini-chat__scroll-thumb,
        .pip-mini-chat[data-stealth-mode="true"] .pip-mini-chat__output,
        .pip-mini-chat[data-stealth-mode="true"] .pip-mini-chat__output * {
            border-color: transparent !important;
            background-color: transparent !important;
            background-image: none !important;
            box-shadow: none !important;
        }
        .pip-mini-chat[data-transparent-background="true"] .pip-mini-chat__output,
        .pip-mini-chat[data-transparent-background="true"] .pip-mini-chat__output * {
            border-color: transparent !important;
            background-color: transparent !important;
            background-image: none !important;
            box-shadow: none !important;
        }
        .pip-mini-chat[data-stealth-mode="true"]:not(:hover):not(:focus-within) {
            grid-template-rows: 0 minmax(0, 1fr) 0 0;
        }
        .pip-mini-chat[data-stealth-mode="true"]:not(:hover):not(:focus-within) .pip-mini-chat__header,
        .pip-mini-chat[data-stealth-mode="true"]:not(:hover):not(:focus-within) .pip-mini-chat__input,
        .pip-mini-chat[data-stealth-mode="true"]:not(:hover):not(:focus-within) .pip-mini-chat__actions,
        .pip-mini-chat[data-stealth-mode="true"]:not(:hover):not(:focus-within) .pip-mini-chat__scrollbar {
            opacity: 0;
            pointer-events: none;
        }
        .pip-mini-chat__header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 10px 12px;
            border-bottom: 1px solid color-mix(
                in srgb,
                var(--SmartThemeBorderColor, #303036) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            background: transparent;
            box-shadow: 0 1px 0 color-mix(
                in srgb,
                var(--SmartThemeBorderColor, #303036) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            transition: opacity 0.18s ease;
        }
        .pip-mini-chat__title {
            overflow: hidden;
            font-size: 1em;
            font-weight: 700;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .pip-mini-chat__status {
            flex: 0 0 auto;
            font-size: 0.86em;
            color: color-mix(
                in srgb,
                var(--SmartThemeQuoteColor, #a1a1aa) var(--pip-text-opacity-percent, 100%),
                transparent
            );
        }
        .pip-mini-chat__status[data-state="generating"] {
            color: color-mix(in srgb, #67e8f9 var(--pip-text-opacity-percent, 100%), transparent);
        }
        .pip-mini-chat__status[data-state="error"] {
            color: color-mix(in srgb, #d33 var(--pip-text-opacity-percent, 100%), transparent);
        }
        .pip-mini-chat__scroll-wrap {
            position: relative;
            min-height: 0;
            overflow: hidden;
        }
        .pip-mini-chat__output {
            height: 100%;
            min-height: 120px;
            overflow-x: hidden;
            overflow-y: auto;
            scrollbar-width: none;
            -ms-overflow-style: none;
            padding: 12px 26px 12px 12px;
            color: var(--SmartThemeBodyColor, #f4f4f5);
            font-size: 1em;
            line-height: 1.55;
            opacity: var(--pip-text-opacity, 1);
            overflow-wrap: anywhere;
        }
        .pip-mini-chat__output::-webkit-scrollbar {
            display: none;
        }
        .pip-mini-chat__scrollbar {
            position: absolute;
            top: 6px;
            right: 4px;
            bottom: 6px;
            width: 14px;
            border-radius: 999px;
            background: color-mix(
                in srgb,
                var(--SmartThemeBorderColor, #303036) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s ease;
        }
        .pip-mini-chat__scrollbar[data-visible="true"] {
            opacity: 1;
            pointer-events: auto;
        }
        .pip-mini-chat__scroll-thumb {
            position: absolute;
            left: 3px;
            top: 0;
            width: 8px;
            min-height: 24px;
            border-radius: 999px;
            background: color-mix(
                in srgb,
                var(--SmartThemeQuoteColor, #a1a1aa) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            cursor: grab;
        }
        .pip-mini-chat__scroll-thumb:hover,
        .pip-mini-chat__scroll-thumb:active {
            background: color-mix(
                in srgb,
                var(--SmartThemeBodyColor, #f4f4f5) var(--pip-background-opacity-percent, 100%),
                transparent
            );
        }
        .pip-mini-chat__scroll-thumb:active {
            cursor: grabbing;
        }
        .pip-mini-chat__output > * {
            max-width: 100%;
        }
        .pip-mini-chat-html-document {
            width: 100%;
            max-width: 100%;
        }
        .pip-mini-chat-html-document img,
        .pip-mini-chat-html-document svg,
        .pip-mini-chat-html-document canvas,
        .pip-mini-chat-html-document video {
            max-width: 100%;
        }
        .pip-mini-chat-empty {
            color: var(--SmartThemeQuoteColor, #a1a1aa);
        }
        .pip-mini-chat__input {
            display: block;
            width: calc(100% - 24px);
            height: 36px;
            min-height: 36px;
            max-height: 76px;
            margin: 0 12px 10px;
            resize: none;
            border: 1px solid color-mix(
                in srgb,
                var(--SmartThemeBorderColor, #3f3f46) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            border-radius: 8px;
            padding: 7px 10px;
            background: color-mix(
                in srgb,
                var(--pip-background-color, var(--SmartThemeBlurTintColor, #202024)) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            color: inherit;
            font: inherit;
            line-height: 20px;
            overflow-y: hidden;
            transition: opacity 0.18s ease;
        }
        .pip-mini-chat__input:focus {
            border-color: color-mix(
                in srgb,
                var(--SmartThemeUnderlineColor, #22d3ee) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            outline: none;
        }
        .pip-mini-chat__actions {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 8px;
            padding: 0 12px 12px;
            background: transparent;
            transition: opacity 0.18s ease;
        }
        .pip-mini-chat__button {
            min-height: 36px;
            border: 1px solid color-mix(
                in srgb,
                var(--SmartThemeBorderColor, #3f3f46) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            border-radius: 8px;
            background: color-mix(
                in srgb,
                var(--SmartThemeBlurTintColor, #27272a) var(--pip-background-opacity-percent, 100%),
                transparent
            );
            color: inherit;
            font: inherit;
            font-weight: 700;
            cursor: pointer;
        }
        .pip-mini-chat__button:hover:not(:disabled) {
            filter: brightness(1.08);
        }
        .pip-mini-chat__button:disabled {
            cursor: not-allowed;
            opacity: 0.5;
        }
        .pip-mini-chat__button--send {
            border-color: color-mix(in srgb, var(--SmartThemeUnderlineColor, #0891b2) var(--pip-background-opacity-percent, 100%), transparent);
            background: color-mix(in srgb, var(--SmartThemeUnderlineColor, #0e7490) var(--pip-background-opacity-percent, 100%), transparent);
        }
        .pip-mini-chat__button--stop {
            border-color: color-mix(in srgb, #b44 var(--pip-background-opacity-percent, 100%), transparent);
            background: color-mix(in srgb, #b44 var(--pip-background-opacity-percent, 100%), transparent);
        }
        .pip-mini-chat__button--regenerate {
            border-color: color-mix(in srgb, var(--SmartThemeQuoteColor, #52525b) var(--pip-background-opacity-percent, 100%), transparent);
            background: color-mix(in srgb, var(--SmartThemeQuoteColor, #3f3f46) var(--pip-background-opacity-percent, 100%), transparent);
        }
    `;
}

const RENDERED_BLOCK_SELECTOR = [
    '.TH-render',
    '.status-preview-wrapper',
    '#ny-status',
    'iframe',
].join(', ');

function getAccessibleFrameDocument(frame) {
    try {
        const doc = frame?.contentDocument ?? frame?.contentWindow?.document;
        return doc?.body ? doc : null;
    } catch {
        return null;
    }
}

function absolutizeClonedResources(sourceRoot, cloneRoot) {
    const sourceElements = [sourceRoot, ...(sourceRoot.querySelectorAll?.('*') ?? [])];
    const cloneElements = [cloneRoot, ...(cloneRoot.querySelectorAll?.('*') ?? [])];
    const urlProperties = ['src', 'href', 'poster'];

    for (let index = 0; index < sourceElements.length; index += 1) {
        const source = sourceElements[index];
        const clone = cloneElements[index];
        if (!clone) {
            continue;
        }

        for (const property of urlProperties) {
            if (!source.hasAttribute?.(property)) {
                continue;
            }

            const absolute = source[property];
            if (/^(?:https?:|data:|blob:)/i.test(String(absolute ?? ''))) {
                clone.setAttribute(property, absolute);
            }
        }
    }
}

function getElementChildPath(element, root) {
    if (element === root) {
        return '';
    }

    const indices = [];
    let current = element;
    while (current && current !== root) {
        const parent = current.parentElement;
        if (!parent) {
            return null;
        }

        const index = Array.prototype.indexOf.call(parent.children, current);
        if (index < 0) {
            return null;
        }
        indices.push(index);
        current = parent;
    }

    return current === root ? indices.reverse().join('.') : null;
}

function annotateClonedInteractionPaths(sourceRoot, cloneRoot) {
    const sourceElements = [sourceRoot, ...(sourceRoot.querySelectorAll?.('*') ?? [])];
    const cloneElements = [cloneRoot, ...(cloneRoot.querySelectorAll?.('*') ?? [])];

    for (let index = 0; index < sourceElements.length; index += 1) {
        const source = sourceElements[index];
        const clone = cloneElements[index];
        if (!clone || ['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE'].includes(source.tagName)) {
            continue;
        }

        const path = getElementChildPath(source, sourceRoot);
        if (path !== null) {
            clone.setAttribute('data-pip-source-path', path);
        }
        if (source.matches?.(
            '[data-veil-action], [data-pip-input], [data-option], .option-item, '
            + '[role="button"], [onclick], [tabindex], button, a, '
            + '[class*="option" i], [class*="choice" i], [class*="action" i], '
            + '[class*="decision" i], [class*="select" i], [class*="card" i]',
        )) {
            clone.setAttribute('data-pip-source-interactive', 'true');
        }
        const sourceText = String(source.textContent || '').replace(/\s+/g, ' ').trim();
        if (
            source.matches?.(
                '[data-option], [data-pip-input], .option-item, '
                + '[class*="option" i], [class*="choice" i], [class*="decision" i]',
            )
            || /^[A-E]\s*.{3,}$/i.test(sourceText)
        ) {
            clone.setAttribute('data-pip-source-option', 'true');
        }
    }
}

function copyFrameRootAppearance(frameDocument, wrapper) {
    try {
        const styles = frameDocument.defaultView?.getComputedStyle?.(frameDocument.body);
        const properties = [
            'background',
            'background-color',
            'background-image',
            'color',
            'font-family',
            'font-size',
            'font-style',
            'font-weight',
            'letter-spacing',
            'line-height',
            'padding',
            'text-align',
        ];

        for (const property of properties) {
            const value = styles?.getPropertyValue?.(property);
            if (value) {
                wrapper.style.setProperty(property, value);
            }
        }

        const rootStyles = frameDocument.defaultView?.getComputedStyle?.(
            frameDocument.documentElement,
        );
        for (const name of rootStyles ?? []) {
            if (name.startsWith('--')) {
                wrapper.style.setProperty(name, rootStyles.getPropertyValue(name));
            }
        }
    } catch {
        // Computed styles are best-effort; serialized style elements remain available.
    }
}

function frameDocumentHasRenderableContent(frameDocument) {
    for (const node of frameDocument?.body?.childNodes ?? []) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            return true;
        }

        if (
            node.nodeType === Node.ELEMENT_NODE
            && !['SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'TEMPLATE'].includes(node.tagName)
        ) {
            return true;
        }
    }

    return false;
}

function serializeFrameDocument(frame, diagnostics = null) {
    const frameDocument = getAccessibleFrameDocument(frame);
    if (!frameDocument || !frameDocumentHasRenderableContent(frameDocument)) {
        return null;
    }

    const wrapper = document.createElement('section');
    wrapper.className = 'pip-mini-chat-embedded-document';
    wrapper.dataset.pipEmbeddedDocument = 'true';
    wrapper.dataset.pipSourceFrameId = String(frame.id || frame.name || '');
    copyFrameRootAppearance(frameDocument, wrapper);

    for (const source of frameDocument.head?.querySelectorAll?.(
        'style, link[rel~="stylesheet"]',
    ) ?? []) {
        const clone = source.cloneNode(true);
        if (source.matches?.('link') && source.href) {
            clone.href = source.href;
        }
        wrapper.append(clone);
    }

    const bodyClone = cloneRenderedNode(frameDocument.body, diagnostics, true);
    while (bodyClone.firstChild) {
        wrapper.append(bodyClone.firstChild);
    }

    if (diagnostics) {
        diagnostics.serializedFrameCount += 1;
    }

    return wrapper;
}

function cloneRenderedNode(sourceNode, diagnostics = null, annotateInteractions = false) {
    const clone = sourceNode.cloneNode(true);
    absolutizeClonedResources(sourceNode, clone);
    if (annotateInteractions) {
        annotateClonedInteractionPaths(sourceNode, clone);
    }
    const sourceFrames = [...(sourceNode.querySelectorAll?.('iframe') ?? [])];
    const cloneFrames = [...(clone.querySelectorAll?.('iframe') ?? [])];

    for (let index = 0; index < sourceFrames.length; index += 1) {
        if (diagnostics) {
            diagnostics.frameCount += 1;
            if (sourceFrames[index].closest?.('.TH-render')) {
                diagnostics.frontendFrameCount += 1;
            }
        }

        const serialized = serializeFrameDocument(sourceFrames[index], diagnostics);
        if (serialized && cloneFrames[index]) {
            cloneFrames[index].replaceWith(serialized);
        }
    }

    return clone;
}

function getExtraRenderedBlocks(messageElement, textElement) {
    const candidates = [...messageElement.querySelectorAll(RENDERED_BLOCK_SELECTOR)];
    return candidates.filter(candidate => {
        if (textElement.contains(candidate)) {
            return false;
        }

        const renderedParent = candidate.parentElement?.closest?.(RENDERED_BLOCK_SELECTOR);
        return !renderedParent || !messageElement.contains(renderedParent);
    });
}

function getRenderedLatestAssistantHtml(context) {
    return getRenderedLatestAssistantSnapshot(context)?.html || null;
}

function getRenderedLatestAssistantSnapshot(context) {
    const latest = findLatestAssistantMessage(context?.chat);
    if (!latest) {
        return null;
    }

    const messageElement = findRenderedMessageElement(latest.index, context?.chat?.length);
    const textElement = messageElement?.querySelector?.('.mes_text') ?? messageElement;
    if (!textElement) {
        return null;
    }

    return sanitizeRenderedMessageSnapshot(textElement, messageElement);
}

function sanitizeRenderedMessageSnapshot(textElement, messageElement = textElement) {
    const diagnostics = {
        frameCount: 0,
        frontendFrameCount: 0,
        serializedFrameCount: 0,
    };
    const sourceCandidates = textElement.querySelectorAll?.('p, pre, code, textarea') ?? [];
    const containsFrontendSource = [...sourceCandidates]
        .some(element => looksLikeRawHtmlSource(element.textContent ?? ''));
    const clone = cloneRenderedNode(textElement, diagnostics);

    for (const renderedBlock of getExtraRenderedBlocks(messageElement, textElement)) {
        let renderedClone;
        if (renderedBlock.matches?.('iframe')) {
            diagnostics.frameCount += 1;
            if (renderedBlock.closest?.('.TH-render')) {
                diagnostics.frontendFrameCount += 1;
            }
            renderedClone = serializeFrameDocument(renderedBlock, diagnostics);
        } else {
            renderedClone = cloneRenderedNode(renderedBlock, diagnostics);
        }
        if (renderedClone) {
            clone.append(renderedClone);
        }
    }

    const hasFinalRenderedBlock = diagnostics.serializedFrameCount > 0 || clone.querySelector?.(
        '.status-preview-wrapper, #ny-status, .pip-mini-chat-embedded-document',
    );

    if (hasFinalRenderedBlock) {
        removeRawHtmlSourceBlocks(clone);
        clone.querySelectorAll?.('.TH-collapse-code-block-button').forEach(element => element.remove());
    }

    return {
        html: clone.innerHTML?.trim() ?? '',
        containsFrontendSource,
        hasFinalRenderedBlock: Boolean(hasFinalRenderedBlock),
        ...diagnostics,
    };
}

function removeRawHtmlSourceBlocks(root) {
    const candidates = [...root.querySelectorAll('p, pre, code, textarea, .mes_reasoning, .edit_textarea')];

    for (const element of candidates) {
        const text = element.textContent ?? '';
        if (looksLikeRawHtmlSource(text)) {
            element.remove();
        }
    }

    for (const node of [...root.childNodes]) {
        if (node.nodeType === Node.TEXT_NODE && looksLikeRawHtmlSource(node.textContent ?? '')) {
            node.remove();
        }
    }
}

function looksLikeRawHtmlSource(text) {
    const value = String(text ?? '');
    return /<!doctype\s+html|<(?:html|body|script)\b|&lt;!doctype\s+html|&lt;(?:html|body|script)\b/i.test(value);
}

function extractDesktopFallbackText(rawMessage) {
    const value = String(rawMessage ?? '');
    const optionBlocks = [...value.matchAll(/<w2g(?:\s[^>]*)?>([\s\S]*?)<\/w2g\s*>/gi)]
        .map(match => match[1].trim())
        .filter(Boolean);
    if (optionBlocks.length) {
        return optionBlocks.join('\n\n');
    }

    return value
        .replace(/<update(?:\s[^>]*)?>[\s\S]*?<\/update\s*>/gi, '')
        .replace(/```(?:html?)?\s*[\s\S]*?<(?:html|body|script)\b[\s\S]*?```/gi, '')
        .trim();
}

function findRenderedMessageElement(messageIndex, chatLength) {
    const exactSelectors = [
        `.mes[mesid="${messageIndex}"]`,
        `.mes[message_id="${messageIndex}"]`,
        `.mes[data-message-id="${messageIndex}"]`,
        `.mes[data-mes-id="${messageIndex}"]`,
        `.mes[data-index="${messageIndex}"]`,
    ];

    for (const selector of exactSelectors) {
        const element = document.querySelector(selector);
        if (element) {
            return element;
        }
    }

    const visibleMessages = [...document.querySelectorAll('.mes')];
    if (!visibleMessages.length) {
        return null;
    }

    const offset = Number.isFinite(chatLength) && chatLength > visibleMessages.length
        ? chatLength - visibleMessages.length
        : 0;
    const visibleIndex = messageIndex - offset;

    if (visibleIndex >= 0 && visibleIndex < visibleMessages.length) {
        return visibleMessages[visibleIndex];
    }

    return visibleMessages[messageIndex] ?? null;
}

function getDesktopRenderPayload() {
    syncGenerationState();
    const context = getContext();
    const latest = findLatestAssistantMessage(context?.chat);
    const rawText = String(latest?.message?.mes ?? '');
    const renderedSnapshot = getRenderedLatestAssistantSnapshot(context);
    let html = renderedSnapshot?.html || formatLatestAssistantMessage({
        chat: context?.chat,
        formatter: context?.messageFormatting,
    });
    let text = extractDesktopFallbackText(rawText) || rawText;

    if (
        renderedSnapshot?.containsFrontendSource
        && renderedSnapshot.serializedFrameCount === 0
    ) {
        html = '';
        text = extractDesktopFallbackText(rawText)
            || '正在等待酒馆助手完成前端界面渲染……';
    }

    return {
        title: getTitle(context),
        html,
        text,
        streaming: isGenerating,
        themeVariables: collectThemeVariables(getComputedStyle(document.documentElement)),
    };
}

function normalizeInteractionText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function collectRenderedInteractionRoots(root) {
    const roots = [root];
    const frames = [...(root.querySelectorAll?.('iframe') ?? [])];

    for (const frame of frames) {
        const frameDocument = getAccessibleFrameDocument(frame);
        if (!frameDocument?.body) {
            continue;
        }

        roots.push(frameDocument.body);
        for (const nestedFrame of frameDocument.body.querySelectorAll('iframe')) {
            const nestedDocument = getAccessibleFrameDocument(nestedFrame);
            if (nestedDocument?.body) {
                roots.push(nestedDocument.body);
            }
        }
    }

    return roots;
}

function collectAccessibleInteractionFrames(root) {
    const results = [];
    const visited = new WeakSet();

    function visit(container) {
        for (const frame of container.querySelectorAll?.('iframe') ?? []) {
            if (visited.has(frame)) {
                continue;
            }
            visited.add(frame);

            const frameDocument = getAccessibleFrameDocument(frame);
            if (!frameDocument?.body) {
                continue;
            }

            results.push({ frame, document: frameDocument });
            visit(frameDocument.body);
        }
    }

    visit(root);
    return results;
}

function resolveElementChildPath(root, value) {
    const path = String(value ?? '');
    if (!path) {
        return root;
    }
    if (!/^\d+(?:\.\d+)*$/.test(path)) {
        return null;
    }

    let current = root;
    for (const part of path.split('.')) {
        current = current?.children?.[Number(part)] ?? null;
        if (!current) {
            return null;
        }
    }
    return current;
}

function findDesktopInteractionTarget(payload = {}) {
    const context = getContext();
    const latest = findLatestAssistantMessage(context?.chat);
    if (!latest) {
        return null;
    }

    const messageElement = findRenderedMessageElement(latest.index, context?.chat?.length);
    const root = messageElement?.querySelector?.('.mes_text') ?? messageElement;
    if (!root) {
        return null;
    }

    const roots = collectRenderedInteractionRoots(root);

    if (
        payload.sourceFrameId
        && typeof payload.sourcePath === 'string'
    ) {
        const expectedFrameId = String(payload.sourceFrameId);
        for (const entry of collectAccessibleInteractionFrames(root)) {
            if (String(entry.frame.id || entry.frame.name || '') !== expectedFrameId) {
                continue;
            }

            const exact = resolveElementChildPath(entry.document.body, payload.sourcePath);
            if (exact) {
                return exact;
            }
        }
    }

    if (payload.id) {
        for (const interactionRoot of roots) {
            const exact = interactionRoot.querySelector?.(
                '#' + globalThis.CSS.escape(String(payload.id)),
            );
            if (exact) {
                return exact;
            }
        }
    }

    const expectedText = normalizeInteractionText(payload.text);
    const expectedValue = normalizeInteractionText(payload.value);
    const expectedAction = normalizeInteractionText(payload.action);
    for (const interactionRoot of roots) {
        const candidates = interactionRoot.querySelectorAll(
            '[data-veil-action], [data-pip-input], [data-option], .option-item, '
            + '[role="button"], [onclick], [tabindex], button, a, '
            + '[class*="option" i], [class*="choice" i], [class*="action" i], '
            + '[class*="decision" i], [class*="select" i], [class*="card" i]',
        );

        for (const candidate of candidates) {
            const values = [
                candidate.dataset?.veilAction,
                candidate.dataset?.pipInput,
                candidate.dataset?.option,
                candidate.dataset?.value,
                candidate.querySelector?.('.option-text')?.textContent,
                candidate.textContent,
            ].map(normalizeInteractionText);

            if (
                (expectedAction && values.includes(expectedAction))
                || (expectedValue && values.includes(expectedValue))
                || (expectedText && values.includes(expectedText))
            ) {
                return candidate;
            }
        }
    }

    return null;
}

async function waitForComposerTextChange(previousValue, timeout = 300) {
    const deadline = Date.now() + timeout;
    let currentValue = String(document.querySelector('#send_textarea')?.value ?? '');

    while (currentValue === previousValue && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
        currentValue = String(document.querySelector('#send_textarea')?.value ?? '');
    }

    return currentValue;
}

async function handleDesktopInteraction(payload = {}) {
    const textareaBeforeClick = document.querySelector('#send_textarea');
    const previousComposerText = String(textareaBeforeClick?.value ?? '');
    const target = findDesktopInteractionTarget(payload);
    if (target) {
        if (typeof target.click === 'function') {
            target.click();
        } else {
            const EventConstructor = target.ownerDocument?.defaultView?.MouseEvent ?? MouseEvent;
            target.dispatchEvent(new EventConstructor('click', {
                bubbles: true,
                cancelable: true,
                composed: true,
            }));
        }

        const composerText = await waitForComposerTextChange(previousComposerText);
        return {
            handled: true,
            composerText: composerText !== previousComposerText ? composerText : null,
        };
    }

    const text = String(payload.text ?? '').trim();
    const textarea = document.querySelector('#send_textarea');
    if (!text || !textarea) {
        return { handled: false, composerText: null };
    }

    textarea.value = String(textarea.value ?? '') + text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    return { handled: true, composerText: textarea.value };
}

function getSillyTavernComposerText() {
    return String(document.querySelector('#send_textarea')?.value ?? '');
}

function sendDesktopComposerUpdate(force = false) {
    const text = getSillyTavernComposerText();
    if (!force && text === lastDesktopComposerText) {
        return false;
    }

    const sent = desktopBridge?.send('composer:update', { text }) ?? false;
    if (sent) {
        lastDesktopComposerText = text;
    }
    return sent;
}

function scheduleDesktopComposerUpdate(delay = 70) {
    clearTimeout(desktopComposerSyncTimer);
    desktopComposerSyncTimer = setTimeout(() => {
        desktopComposerSyncTimer = null;
        sendDesktopComposerUpdate();
    }, delay);
}

function applyDesktopComposerText(value) {
    const textarea = document.querySelector('#send_textarea');
    if (!textarea) {
        return false;
    }

    const text = String(value ?? '').slice(0, 20_000);
    if (textarea.value === text) {
        lastDesktopComposerText = text;
        return true;
    }

    applyingDesktopComposerUpdate = true;
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    applyingDesktopComposerUpdate = false;
    lastDesktopComposerText = text;
    return true;
}

function installDesktopComposerSync() {
    if (desktopComposerInputListenerInstalled) {
        return;
    }

    desktopComposerInputListenerInstalled = true;
    document.addEventListener('input', event => {
        if (
            applyingDesktopComposerUpdate
            || !event.target?.matches?.('#send_textarea')
        ) {
            return;
        }
        scheduleDesktopComposerUpdate();
    }, true);
}

async function handleDesktopBridgeAction(message) {
    if (message.type === 'composer:update') {
        applyDesktopComposerText(message.payload?.text);
        return null;
    }
    if (message.type === 'composer:send') {
        await sendTextToSillyTavern(String(message.payload?.text ?? ''));
        return;
    }
    if (message.type === 'generation:retry') {
        await regenerateLastMessage();
        return;
    }
    if (message.type === 'generation:stop') {
        stopGeneration();
        return;
    }
    if (message.type === 'interaction:select') {
        return handleDesktopInteraction(message.payload);
    }

    return null;
}

function initializeDesktopBridge() {
    if (desktopBridge) {
        desktopBridge.setSettings(desktopBridgeSettings);
        return;
    }

    desktopBridge = new DesktopBridge({
        settings: desktopBridgeSettings,
        getRenderPayload: getDesktopRenderPayload,
        getGenerationState: () => {
            syncGenerationState();
            return isGenerating;
        },
        onAction: handleDesktopBridgeAction,
        onStatus: status => {
            desktopBridgeStatus = status;
            syncDesktopBridgeSettingsPanel();
            if (status.state === 'connected') {
                sendDesktopComposerUpdate(true);
            }
        },
    });
    desktopBridge.start();
}

function installDesktopMutationObserver() {
    const chat = document.querySelector('#chat');
    if (!chat || chat === desktopObservedChat) {
        return false;
    }

    desktopMutationObserver?.disconnect();
    desktopObservedChat = chat;
    desktopMutationObserver = new MutationObserver(() => {
        desktopBridge?.scheduleSync(120);
    });
    desktopMutationObserver.observe(chat, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
    });
    desktopBridge?.sync(true);
    return true;
}

function getDesktopChatSignature() {
    const context = getContext();
    const latest = findLatestAssistantMessage(context?.chat);
    const text = String(latest?.message?.mes ?? '');

    return JSON.stringify({
        characterId: context?.characterId ?? null,
        groupId: context?.groupId ?? null,
        chatId: context?.chatId ?? context?.chat_id ?? null,
        chatLength: Array.isArray(context?.chat) ? context.chat.length : 0,
        latestIndex: latest?.index ?? -1,
        latestLength: text.length,
        latestTail: text.slice(-160),
    });
}

function startDesktopSyncHeartbeat() {
    if (desktopSyncHeartbeatTimer) {
        return;
    }

    desktopSyncHeartbeatTimer = window.setInterval(() => {
        const observerChanged = installDesktopMutationObserver();
        const signature = getDesktopChatSignature();
        if (observerChanged || signature !== lastDesktopChatSignature) {
            lastDesktopChatSignature = signature;
            desktopBridge?.sync(true);
        } else {
            desktopBridge?.sync();
        }
    }, 1000);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            installDesktopMutationObserver();
            lastDesktopChatSignature = getDesktopChatSignature();
            desktopBridge?.sync(true);
        }
    });
}

function copyThemeToPipDocument(targetDocument) {
    const themeVariables = collectThemeVariables(getComputedStyle(document.documentElement));
    const css = buildThemeVariableCss(themeVariables);

    if (!css) {
        return;
    }

    const style = targetDocument.createElement('style');
    style.dataset.pipMiniChatTheme = 'true';
    style.textContent = css;
    targetDocument.head.append(style);
}

function asPercent(value) {
    return `${Math.round(clampNumber(value, 0, 1, 1) * 100)}%`;
}

function applyAppearanceSettings() {
    const root = pipElements?.root;
    if (!root || !pipWindow?.document) {
        return;
    }

    const backgroundColor = appearanceSettings.useThemeBackground
        ? 'var(--SmartThemeBlurTintColor, #171717)'
        : appearanceSettings.backgroundColor;

    root.style.setProperty('--pip-background-color', backgroundColor);
    root.style.setProperty('--pip-background-opacity-percent', asPercent(appearanceSettings.backgroundOpacity));
    root.style.setProperty('--pip-text-opacity-percent', asPercent(appearanceSettings.textOpacity));
    root.style.setProperty('--pip-text-opacity', String(appearanceSettings.textOpacity));
    root.style.setProperty('--pip-font-family', FONT_FAMILIES[appearanceSettings.fontFamily]);
    root.style.setProperty('--pip-font-size', `${appearanceSettings.fontSize}px`);
    root.dataset.stealthMode = String(appearanceSettings.stealthMode);
    root.dataset.transparentBackground = String(appearanceSettings.backgroundOpacity === 0);
    pipWindow.document.title = appearanceSettings.stealthMode ? 'Window' : '隐蔽小窗';
}

function buildPipDocument(targetWindow) {
    const doc = targetWindow.document;
    doc.title = appearanceSettings.stealthMode ? 'Window' : '隐蔽小窗';
    doc.body.innerHTML = `
        <main class="pip-mini-chat">
            <header class="pip-mini-chat__header">
                <div class="pip-mini-chat__title"></div>
                <div class="pip-mini-chat__status" data-state="idle">Idle</div>
            </header>
            <div class="pip-mini-chat__scroll-wrap">
                <section class="pip-mini-chat__output" aria-live="polite"></section>
                <div class="pip-mini-chat__scrollbar" aria-hidden="true">
                    <div class="pip-mini-chat__scroll-thumb"></div>
                </div>
            </div>
            <textarea id="send_textarea" class="pip-mini-chat__input" rows="1" placeholder="Message"></textarea>
            <div class="pip-mini-chat__actions">
                <button class="pip-mini-chat__button pip-mini-chat__button--send" type="button">Send</button>
                <button class="pip-mini-chat__button pip-mini-chat__button--regenerate" type="button">Retry</button>
                <button class="pip-mini-chat__button pip-mini-chat__button--stop" type="button">Stop</button>
            </div>
        </main>
    `;

    const style = doc.createElement('style');
    copyThemeToPipDocument(doc);
    style.textContent = getPipStyles();
    doc.head.append(style);

    pipElements = {
        root: doc.querySelector('.pip-mini-chat'),
        title: doc.querySelector('.pip-mini-chat__title'),
        status: doc.querySelector('.pip-mini-chat__status'),
        output: doc.querySelector('.pip-mini-chat__output'),
        scrollbar: doc.querySelector('.pip-mini-chat__scrollbar'),
        scrollbarThumb: doc.querySelector('.pip-mini-chat__scroll-thumb'),
        input: doc.querySelector('.pip-mini-chat__input'),
        send: doc.querySelector('.pip-mini-chat__button--send'),
        regenerate: doc.querySelector('.pip-mini-chat__button--regenerate'),
        stop: doc.querySelector('.pip-mini-chat__button--stop'),
    };

    applyAppearanceSettings();
    resizePipInput();
    setupPipScrollbar();
    installPipInteractionFallbacks();
    pipElements.input.addEventListener('input', () => {
        resizePipInput();
        updateControls();
    });
    pipElements.input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void sendDraft();
        }
    });
    pipElements.send.addEventListener('click', () => void sendDraft());
    pipElements.regenerate.addEventListener('click', () => void regenerateLastMessage());
    pipElements.stop.addEventListener('click', stopGeneration);
}

function resizePipInput() {
    if (!pipElements?.input) {
        return;
    }

    const rawLineCount = String(pipElements.input.value ?? '').split('\n').length;
    const rowCount = getTextareaRowCount(pipElements.input.value);
    const height = 16 + (rowCount * 20);

    pipElements.input.rows = rowCount;
    pipElements.input.style.height = `${height}px`;
    pipElements.input.style.overflowY = rawLineCount > 3 ? 'auto' : 'hidden';
}

function setupPipScrollbar() {
    if (!pipElements?.output || !pipElements?.scrollbar || !pipElements?.scrollbarThumb || !pipWindow) {
        return;
    }

    let dragState = null;

    pipElements.output.addEventListener('scroll', updatePipScrollbar);
    pipWindow.addEventListener('resize', updatePipScrollbar);

    const resizeObserver = new pipWindow.ResizeObserver(updatePipScrollbar);
    resizeObserver.observe(pipElements.output);

    const mutationObserver = new pipWindow.MutationObserver(updatePipScrollbar);
    mutationObserver.observe(pipElements.output, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
    });

    pipElements.scrollbar.addEventListener('pointerdown', event => {
        if (pipElements.scrollbar.dataset.visible !== 'true') {
            return;
        }

        event.preventDefault();
        const barRect = pipElements.scrollbar.getBoundingClientRect();
        const thumbRect = pipElements.scrollbarThumb.getBoundingClientRect();
        const clickedThumb = event.target === pipElements.scrollbarThumb;
        const thumbOffset = clickedThumb
            ? event.clientY - thumbRect.top
            : thumbRect.height / 2;

        dragState = {
            pointerId: event.pointerId,
            offsetY: thumbOffset,
        };

        pipElements.scrollbar.setPointerCapture?.(event.pointerId);
        updateScrollFromThumbPosition(event.clientY - barRect.top - thumbOffset);
    });

    pipElements.scrollbar.addEventListener('pointermove', event => {
        if (!dragState || event.pointerId !== dragState.pointerId) {
            return;
        }

        event.preventDefault();
        const barRect = pipElements.scrollbar.getBoundingClientRect();
        updateScrollFromThumbPosition(event.clientY - barRect.top - dragState.offsetY);
    });

    pipElements.scrollbar.addEventListener('pointerup', event => {
        if (!dragState || event.pointerId !== dragState.pointerId) {
            return;
        }

        pipElements.scrollbar.releasePointerCapture?.(event.pointerId);
        dragState = null;
    });

    pipWindow.addEventListener('pagehide', () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
    }, { once: true });

    updatePipScrollbar();
}

function updateScrollFromThumbPosition(thumbTop) {
    const output = pipElements?.output;
    const scrollbar = pipElements?.scrollbar;
    const thumb = pipElements?.scrollbarThumb;
    if (!output || !scrollbar || !thumb) {
        return;
    }

    const trackHeight = scrollbar.clientHeight;
    const thumbHeight = thumb.offsetHeight;
    const scrollRange = output.scrollHeight - output.clientHeight;
    const thumbRange = Math.max(trackHeight - thumbHeight, 1);
    const clampedTop = Math.min(Math.max(thumbTop, 0), thumbRange);
    output.scrollTop = (clampedTop / thumbRange) * scrollRange;
}

function updatePipScrollbar() {
    const output = pipElements?.output;
    const scrollbar = pipElements?.scrollbar;
    const thumb = pipElements?.scrollbarThumb;
    if (!output || !scrollbar || !thumb) {
        return;
    }

    const scrollHeight = output.scrollHeight;
    const clientHeight = output.clientHeight;
    const hasOverflow = scrollHeight > clientHeight + 1;
    scrollbar.dataset.visible = String(hasOverflow);

    if (!hasOverflow) {
        thumb.style.height = '24px';
        thumb.style.transform = 'translateY(0)';
        return;
    }

    const trackHeight = scrollbar.clientHeight;
    const thumbHeight = Math.max(24, Math.round((clientHeight / scrollHeight) * trackHeight));
    const thumbRange = Math.max(trackHeight - thumbHeight, 1);
    const scrollRange = Math.max(scrollHeight - clientHeight, 1);
    const top = Math.round((output.scrollTop / scrollRange) * thumbRange);

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${top}px)`;
}

function createPipJQueryBridge(hostJQuery) {
    const pipDocument = pipWindow?.document;
    if (typeof hostJQuery !== 'function' || !pipDocument) {
        return hostJQuery;
    }

    const bridge = function pipJQueryBridge(selector, context) {
        if (typeof selector === 'function') {
            if (pipDocument.readyState === 'loading') {
                pipDocument.addEventListener('DOMContentLoaded', () => selector(bridge), { once: true });
            } else {
                selector(bridge);
            }
            return hostJQuery(pipDocument);
        }

        if (typeof selector === 'string' && context === undefined) {
            return hostJQuery(selector, pipDocument);
        }

        return hostJQuery(selector, context);
    };

    Object.setPrototypeOf(bridge, Object.getPrototypeOf(hostJQuery));
    Object.assign(bridge, hostJQuery);
    bridge.fn = hostJQuery.fn;

    return bridge;
}

function bridgeHostGlobalsToPipWindow() {
    if (!pipWindow || pipWindow.closed) {
        return;
    }

    const hostJQuery = globalThis.jQuery ?? globalThis.$;
    if (typeof hostJQuery === 'function') {
        const pipJQuery = createPipJQueryBridge(hostJQuery);
        pipWindow.$ = pipJQuery;
        pipWindow.jQuery = pipJQuery;
    }

    pipWindow.setPipMiniChatInput = text => writePipInput(text, { append: false });
    pipWindow.appendPipMiniChatInput = text => writePipInput(text, { append: true });
    pipWindow.triggerSlash = command => {
        const inputMatch = String(command ?? '').match(/^\/setinput\s+([\s\S]*)$/i);
        if (inputMatch) {
            writePipInput(inputMatch[1], { append: false });
            return true;
        }

        return globalThis.triggerSlash?.(command);
    };

    const names = [
        '_',
        'toastr',
        'SillyTavern',
        'TavernHelper',
        'Mvu',
        'getAllVariables',
        'waitGlobalInitialized',
        'eventOn',
        'eventMakeLast',
        'eventSource',
        'eventTypes',
        'errorCatched',
    ];

    for (const name of names) {
        if (globalThis[name] !== undefined) {
            try {
                pipWindow[name] = globalThis[name];
            } catch {
                // Best-effort compatibility bridge for user-provided status HTML.
            }
        }
    }
}

function executeOutputScripts(container) {
    const scripts = container?.querySelectorAll?.('script') ?? [];

    withPipDocumentCompatibility(() => {
        for (const script of scripts) {
            const replacement = pipWindow.document.createElement('script');
            for (const attribute of script.attributes) {
                replacement.setAttribute(attribute.name, attribute.value);
            }
            replacement.textContent = script.textContent;
            script.replaceWith(replacement);
        }
    });
}

function withPipDocumentCompatibility(callback) {
    if (!pipWindow?.document || typeof callback !== 'function') {
        return;
    }

    const doc = pipWindow.document;
    const originalAddEventListener = doc.addEventListener.bind(doc);
    const originalWindowAddEventListener = pipWindow.addEventListener.bind(pipWindow);

    const makeDomReadyCompat = original => function addEventListenerCompat(type, listener, options) {
        if (type === 'DOMContentLoaded' && doc.readyState !== 'loading' && typeof listener === 'function') {
            pipWindow.setTimeout(() => {
                listener.call(doc, new Event('DOMContentLoaded'));
            }, 0);
        }

        return original(type, listener, options);
    };

    doc.addEventListener = makeDomReadyCompat(originalAddEventListener);
    pipWindow.addEventListener = makeDomReadyCompat(originalWindowAddEventListener);

    try {
        callback();
    } finally {
        doc.addEventListener = originalAddEventListener;
        pipWindow.addEventListener = originalWindowAddEventListener;
    }
}

function installPipInteractionFallbacks() {
    if (!pipElements?.output) {
        return;
    }

    pipElements.output.addEventListener('click', event => {
        const target = event.target?.closest?.('[data-pip-input], .option-item');
        if (!target) {
            return;
        }

        const valueBeforeClick = pipElements.input.value;
        pipWindow.setTimeout(() => {
            if (pipElements.input.value !== valueBeforeClick) {
                return;
            }

            const text = target.dataset.pipInput || target.querySelector?.('.option-text')?.textContent || target.textContent;
            if (text?.trim()) {
                writePipInput(text.trim(), { append: true });
            }
        }, 0);
    });
}

function cleanupPip() {
    pipWindow = null;
    pipElements = null;
    isGenerating = false;
    lastRenderedOutputHtml = '';
}

async function openPipWindow() {
    if (!window.documentPictureInPicture?.requestWindow) {
        notifyError('Document Picture-in-Picture is unavailable. Please use Chrome or Edge.');
        return;
    }

    if (pipWindow && !pipWindow.closed) {
        pipWindow.focus();
        return;
    }

    try {
        pipWindow = await window.documentPictureInPicture.requestWindow({
            width: PIP_WIDTH,
            height: PIP_HEIGHT,
        });
        isGenerating = false;
        buildPipDocument(pipWindow);
        void loadSillyTavernStatusHelpers().then(() => {
            syncGenerationState();
            refreshPip();
        });
        registerPipEventListeners();
        pipWindow.addEventListener('pagehide', cleanupPip, { once: true });
        refreshPip();
        pipElements.input.focus();
    } catch (error) {
        cleanupPip();
        notifyError(error?.message ?? 'Could not open PiP window', error);
    }
}

function closePipWindow() {
    if (!shouldClosePipWindow(pipWindow)) {
        cleanupPip();
        return;
    }

    const windowToClose = pipWindow;
    cleanupPip();
    windowToClose.close();
}

async function togglePipWindow() {
    if (shouldClosePipWindow(pipWindow)) {
        closePipWindow();
        return;
    }

    await openPipWindow();
}

function createLauncherButton({ id, variant }) {
    const button = document.createElement('div');
    button.id = id;
    button.className = variant === 'menu'
        ? 'list-group-item flex-container flexGap5 interactable pip-mini-chat-menu-launcher'
        : 'pip-mini-chat-floating-launcher interactable';
    button.tabIndex = 0;
    button.role = 'button';
    button.title = '打开隐蔽小窗';
    button.innerHTML = variant === 'menu'
        ? `${getLauncherIcon()}<span>隐蔽小窗</span>`
        : getLauncherIcon();
    button.addEventListener('click', event => {
        if (button.dataset.dragMoved === 'true') {
            event.preventDefault();
            button.dataset.dragMoved = 'false';
            return;
        }

        void togglePipWindow();
    });
    button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void togglePipWindow();
        }
    });

    if (variant === 'floating') {
        restoreFloatingLauncherPosition(button);
        enableFloatingLauncherDrag(button);
    }

    return button;
}

function getLauncherIcon() {
    return `
        <svg class="pip-mini-chat-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="3" y="5" width="18" height="14" rx="2"></rect>
            <rect x="12" y="11" width="6" height="4" rx="1"></rect>
        </svg>
    `;
}

function getStoredFloatingPosition() {
    try {
        const raw = localStorage.getItem(FLOATING_POSITION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function storeFloatingPosition(position) {
    try {
        localStorage.setItem(FLOATING_POSITION_KEY, JSON.stringify(position));
    } catch {
        // Position persistence is a convenience only.
    }
}

function getFloatingLauncherSize(button) {
    const rect = button.getBoundingClientRect();
    return {
        width: rect.width || 44,
        height: rect.height || 36,
    };
}

function applyFloatingLauncherPosition(button, position) {
    button.style.left = `${position.left}px`;
    button.style.top = `${position.top}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
}

function restoreFloatingLauncherPosition(button) {
    const stored = getStoredFloatingPosition();
    if (!stored || !Number.isFinite(stored.left) || !Number.isFinite(stored.top)) {
        return;
    }

    const size = getFloatingLauncherSize(button);
    applyFloatingLauncherPosition(button, normalizeFloatingPosition({
        left: stored.left,
        top: stored.top,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        elementWidth: size.width,
        elementHeight: size.height,
        margin: FLOATING_DRAG_MARGIN,
    }));
}

function enableFloatingLauncherDrag(button) {
    let dragState = null;

    button.addEventListener('pointerdown', event => {
        if (event.button !== 0) {
            return;
        }

        const rect = button.getBoundingClientRect();
        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            moved: false,
        };
        button.setPointerCapture?.(event.pointerId);
    });

    button.addEventListener('pointermove', event => {
        if (!dragState || event.pointerId !== dragState.pointerId) {
            return;
        }

        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 4) {
            dragState.moved = true;
        }

        const size = getFloatingLauncherSize(button);
        const position = normalizeFloatingPosition({
            left: dragState.left + deltaX,
            top: dragState.top + deltaY,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            elementWidth: size.width,
            elementHeight: size.height,
            margin: FLOATING_DRAG_MARGIN,
        });
        applyFloatingLauncherPosition(button, position);
    });

    button.addEventListener('pointerup', event => {
        if (!dragState || event.pointerId !== dragState.pointerId) {
            return;
        }

        button.releasePointerCapture?.(event.pointerId);
        const position = {
            left: button.getBoundingClientRect().left,
            top: button.getBoundingClientRect().top,
        };
        storeFloatingPosition(position);

        if (dragState.moved) {
            button.dataset.dragMoved = 'true';
            window.setTimeout(() => {
                button.dataset.dragMoved = 'false';
            }, 150);
        }

        dragState = null;
    });

    window.addEventListener('resize', () => restoreFloatingLauncherPosition(button));
}

function registerLauncher() {
    for (const target of getLauncherTargets(document)) {
        if (document.getElementById(target.id)) {
            continue;
        }

        target.host.append(createLauncherButton(target));
    }
}

function setCompatibleSendMode(enabled) {
    compatibleSendMode = Boolean(enabled);
    writeBooleanSetting({
        storage: globalThis.localStorage,
        key: COMPATIBLE_SEND_MODE_KEY,
        value: compatibleSendMode,
    });
}

function syncAppearanceSettingsPanel(panel = document.getElementById('pip-mini-chat-settings')) {
    if (!panel) {
        return;
    }

    const useThemeBackground = panel.querySelector('#pip-mini-chat-use-theme-background');
    const backgroundColor = panel.querySelector('#pip-mini-chat-background-color');
    const backgroundOpacity = panel.querySelector('#pip-mini-chat-background-opacity');
    const fontFamily = panel.querySelector('#pip-mini-chat-font-family');
    const fontSize = panel.querySelector('#pip-mini-chat-font-size');
    const textOpacity = panel.querySelector('#pip-mini-chat-text-opacity');
    const stealthMode = panel.querySelector('#pip-mini-chat-stealth-mode');

    useThemeBackground.checked = appearanceSettings.useThemeBackground;
    backgroundColor.value = appearanceSettings.backgroundColor;
    backgroundColor.disabled = appearanceSettings.useThemeBackground;
    backgroundOpacity.value = String(Math.round(appearanceSettings.backgroundOpacity * 100));
    panel.querySelector('[data-value-for="pip-mini-chat-background-opacity"]').textContent = asPercent(appearanceSettings.backgroundOpacity);
    fontFamily.value = appearanceSettings.fontFamily;
    fontSize.value = String(appearanceSettings.fontSize);
    panel.querySelector('[data-value-for="pip-mini-chat-font-size"]').textContent = `${appearanceSettings.fontSize}px`;
    textOpacity.value = String(Math.round(appearanceSettings.textOpacity * 100));
    panel.querySelector('[data-value-for="pip-mini-chat-text-opacity"]').textContent = asPercent(appearanceSettings.textOpacity);
    stealthMode.checked = appearanceSettings.stealthMode;
}

function syncDesktopBridgeSettingsPanel(panel = document.getElementById('pip-mini-chat-settings')) {
    if (!panel) {
        return;
    }

    const enabled = panel.querySelector('#pip-mini-chat-desktop-enabled');
    const url = panel.querySelector('#pip-mini-chat-desktop-url');
    const token = panel.querySelector('#pip-mini-chat-desktop-token');
    const status = panel.querySelector('#pip-mini-chat-desktop-status');
    if (!enabled || !url || !token || !status) {
        return;
    }

    enabled.checked = desktopBridgeSettings.enabled;
    url.value = desktopBridgeSettings.url;
    token.value = desktopBridgeSettings.token;
    status.dataset.state = desktopBridgeStatus.state;

    const label = getDesktopBridgeStatusText(desktopBridgeStatus);
    status.textContent = desktopBridgeStatus.detail
        ? label + '：' + desktopBridgeStatus.detail
        : label;
}

function registerSettingsPanel() {
    if (document.getElementById('pip-mini-chat-settings')) {
        return;
    }

    const host = document.querySelector('#extensions_settings');
    if (!host) {
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'pip-mini-chat-settings';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>隐蔽小窗</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="pip-mini-chat-settings__section">
                    <div class="pip-mini-chat-settings__section-title">小窗外观</div>

                    <label class="checkbox_label pip-mini-chat-settings__row" for="pip-mini-chat-use-theme-background">
                        <input id="pip-mini-chat-use-theme-background" type="checkbox" class="checkbox">
                        <span>背景色跟随酒馆主题</span>
                    </label>

                    <label class="pip-mini-chat-settings__field" for="pip-mini-chat-background-color">
                        <span>自定义背景色</span>
                        <input id="pip-mini-chat-background-color" type="color" value="#171717">
                    </label>

                    <label class="pip-mini-chat-settings__slider" for="pip-mini-chat-background-opacity">
                        <span>背景不透明度</span>
                        <output data-value-for="pip-mini-chat-background-opacity">100%</output>
                        <input id="pip-mini-chat-background-opacity" type="range" min="0" max="100" step="5">
                    </label>
                    <small class="pip-mini-chat-settings__hint">
                        设为 0% 时，插件自身的背景、边框和按钮底色会完全透明，仅保留内容。
                    </small>

                    <label class="pip-mini-chat-settings__field" for="pip-mini-chat-font-family">
                        <span>字体</span>
                        <select id="pip-mini-chat-font-family" class="text_pole">
                            <option value="system">系统界面字体</option>
                            <option value="sans">微软雅黑 / 无衬线</option>
                            <option value="serif">宋体 / 衬线</option>
                            <option value="kai">楷体</option>
                            <option value="mono">等宽字体</option>
                        </select>
                    </label>

                    <label class="pip-mini-chat-settings__slider" for="pip-mini-chat-font-size">
                        <span>字号</span>
                        <output data-value-for="pip-mini-chat-font-size">14px</output>
                        <input id="pip-mini-chat-font-size" type="range" min="10" max="24" step="1">
                    </label>

                    <label class="pip-mini-chat-settings__slider" for="pip-mini-chat-text-opacity">
                        <span>文字不透明度</span>
                        <output data-value-for="pip-mini-chat-text-opacity">100%</output>
                        <input id="pip-mini-chat-text-opacity" type="range" min="10" max="100" step="5">
                    </label>
                    <small class="pip-mini-chat-settings__hint">不透明度越低，背景或文字就越透明。</small>
                </div>

                <div class="pip-mini-chat-settings__section">
                    <div class="pip-mini-chat-settings__section-title">隐蔽模式</div>
                    <label class="checkbox_label pip-mini-chat-settings__row" for="pip-mini-chat-stealth-mode">
                        <input id="pip-mini-chat-stealth-mode" type="checkbox" class="checkbox">
                        <span>开启隐蔽模式</span>
                    </label>
                    <small class="pip-mini-chat-settings__hint">
                        鼠标移出小窗后插件内容完全不可见；移入后只恢复文字和控件，不恢复插件背景色块。
                    </small>
                    <small class="pip-mini-chat-settings__hint">
                        浏览器顶部的来源栏和系统窗口底色属于 Chromium 安全界面，插件无法修改或使其透出后方桌面。
                    </small>
                </div>

                <button id="pip-mini-chat-reset-appearance" type="button" class="menu_button pip-mini-chat-settings__reset">
                    恢复默认外观
                </button>

                <div class="pip-mini-chat-settings__section pip-mini-chat-settings__section--compatibility">
                    <div class="pip-mini-chat-settings__section-title">兼容性</div>
                    <label class="checkbox_label pip-mini-chat-settings__row" for="pip-mini-chat-compatible-send-mode">
                        <input id="pip-mini-chat-compatible-send-mode" type="checkbox" class="checkbox">
                        <span>兼容发送拦截插件</span>
                    </label>
                    <small class="pip-mini-chat-settings__hint">
                        开启后，小窗发送前会向主页面发送按钮发出一次发送意图信号，用于兼容数据库、剧情规划等拦截脚本。
                    </small>
                </div>

                <div class="pip-mini-chat-settings__section pip-mini-chat-settings__section--desktop">
                    <div class="pip-mini-chat-settings__section-title">隐窗伴侣（插件 v${EXTENSION_VERSION}）</div>
                    <label class="checkbox_label pip-mini-chat-settings__row" for="pip-mini-chat-desktop-enabled">
                        <input id="pip-mini-chat-desktop-enabled" type="checkbox" class="checkbox">
                        <span>启用桌面伴侣通信</span>
                    </label>
                    <div class="pip-mini-chat-settings__desktop-status">
                        状态：<span id="pip-mini-chat-desktop-status" data-state="disabled">未启用</span>
                    </div>
                    <label class="pip-mini-chat-settings__field pip-mini-chat-settings__field--stacked" for="pip-mini-chat-desktop-url">
                        <span>本机连接地址</span>
                        <input id="pip-mini-chat-desktop-url" type="text" class="text_pole" autocomplete="off">
                    </label>
                    <label class="pip-mini-chat-settings__field pip-mini-chat-settings__field--stacked" for="pip-mini-chat-desktop-token">
                        <span>连接令牌</span>
                        <input id="pip-mini-chat-desktop-token" type="password" class="text_pole" autocomplete="off">
                    </label>
                    <label class="pip-mini-chat-settings__field pip-mini-chat-settings__field--stacked" for="pip-mini-chat-desktop-config-import">
                        <span>快速导入</span>
                        <textarea
                            id="pip-mini-chat-desktop-config-import"
                            class="text_pole"
                            rows="3"
                            placeholder="粘贴隐窗伴侣中“复制配置”的内容"
                        ></textarea>
                    </label>
                    <div class="pip-mini-chat-settings__desktop-actions">
                        <button id="pip-mini-chat-desktop-apply-config" type="button" class="menu_button">应用连接配置</button>
                        <button id="pip-mini-chat-desktop-reconnect" type="button" class="menu_button">重新连接</button>
                        <button id="pip-mini-chat-desktop-sync-now" type="button" class="menu_button">立即同步当前聊天</button>
                    </div>
                    <small class="pip-mini-chat-settings__hint">
                        隐窗伴侣需要先启动。通信仅允许 127.0.0.1、localhost 或本机 IPv6 回环地址。
                    </small>
                </div>
            </div>
        </div>
    `;

    const compatibleCheckbox = panel.querySelector('#pip-mini-chat-compatible-send-mode');
    compatibleCheckbox.checked = compatibleSendMode;
    compatibleCheckbox.addEventListener('change', () => {
        setCompatibleSendMode(compatibleCheckbox.checked);
    });

    const desktopEnabled = panel.querySelector('#pip-mini-chat-desktop-enabled');
    const desktopUrl = panel.querySelector('#pip-mini-chat-desktop-url');
    const desktopToken = panel.querySelector('#pip-mini-chat-desktop-token');
    const desktopConfigImport = panel.querySelector('#pip-mini-chat-desktop-config-import');

    desktopEnabled.addEventListener('change', () => {
        updateDesktopBridgeSettings({ enabled: desktopEnabled.checked });
    });
    desktopUrl.addEventListener('change', () => {
        updateDesktopBridgeSettings({ url: desktopUrl.value });
    });
    desktopToken.addEventListener('change', () => {
        updateDesktopBridgeSettings({ token: desktopToken.value });
    });
    panel.querySelector('#pip-mini-chat-desktop-apply-config').addEventListener('click', () => {
        try {
            const settings = parseDesktopBridgeConfiguration(
                desktopConfigImport.value,
                desktopBridgeSettings,
            );
            updateDesktopBridgeSettings(settings);
            desktopConfigImport.value = '';
            globalThis.toastr?.success?.('隐窗伴侣连接配置已应用。', '隐蔽小窗');
        } catch (error) {
            globalThis.toastr?.error?.(error.message, '隐蔽小窗');
        }
    });
    panel.querySelector('#pip-mini-chat-desktop-reconnect').addEventListener('click', () => {
        desktopBridge?.connect();
    });
    panel.querySelector('#pip-mini-chat-desktop-sync-now').addEventListener('click', () => {
        installDesktopMutationObserver();
        lastDesktopChatSignature = getDesktopChatSignature();
        const sent = desktopBridge?.sync(true);
        if (sent) {
            globalThis.toastr?.success?.('当前聊天已同步到隐窗伴侣。', '隐蔽小窗');
        } else {
            globalThis.toastr?.warning?.('隐窗伴侣尚未连接。', '隐蔽小窗');
        }
    });

    panel.querySelector('#pip-mini-chat-use-theme-background').addEventListener('change', event => {
        updateAppearanceSettings({ useThemeBackground: event.currentTarget.checked });
    });
    panel.querySelector('#pip-mini-chat-background-color').addEventListener('input', event => {
        updateAppearanceSettings({ backgroundColor: event.currentTarget.value });
    });
    panel.querySelector('#pip-mini-chat-background-opacity').addEventListener('input', event => {
        updateAppearanceSettings({ backgroundOpacity: Number(event.currentTarget.value) / 100 });
    });
    panel.querySelector('#pip-mini-chat-font-family').addEventListener('change', event => {
        updateAppearanceSettings({ fontFamily: event.currentTarget.value });
    });
    panel.querySelector('#pip-mini-chat-font-size').addEventListener('input', event => {
        updateAppearanceSettings({ fontSize: Number(event.currentTarget.value) });
    });
    panel.querySelector('#pip-mini-chat-text-opacity').addEventListener('input', event => {
        updateAppearanceSettings({ textOpacity: Number(event.currentTarget.value) / 100 });
    });
    panel.querySelector('#pip-mini-chat-stealth-mode').addEventListener('change', event => {
        updateAppearanceSettings({ stealthMode: event.currentTarget.checked });
    });
    panel.querySelector('#pip-mini-chat-reset-appearance').addEventListener('click', () => {
        appearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS };
        writeAppearanceSettings();
        applyAppearanceSettings();
        syncAppearanceSettingsPanel(panel);
    });

    syncAppearanceSettingsPanel(panel);
    syncDesktopBridgeSettingsPanel(panel);
    host.append(panel);
}

function startLauncherRetry() {
    if (launcherRetryTimer) {
        return;
    }

    launcherRetryTimer = window.setInterval(() => {
        registerSettingsPanel();
        registerLauncher();
        installDesktopMutationObserver();
        launcherRetryCount += 1;

        if (
            (document.getElementById('pip-mini-chat-menu-open') && document.getElementById('pip-mini-chat-settings')) ||
            launcherRetryCount >= LAUNCHER_RETRY_LIMIT
        ) {
            window.clearInterval(launcherRetryTimer);
            launcherRetryTimer = null;
        }
    }, 500);
}

function handleEvent(eventName) {
    if (eventName === 'generation_started') {
        isGenerating = true;
    }

    if (eventName === 'generation_stopped' || eventName === 'generation_ended') {
        isGenerating = false;
    }

    syncGenerationState();
    refreshPip();
    desktopBridge?.sendGenerationState();
    desktopBridge?.scheduleSync(40);
}

function registerPipEventListeners() {
    cleanupPipEventListeners?.();

    const context = getContext();
    const eventSource = context?.eventSource;
    if (!eventSource?.on) {
        return;
    }

    cleanupPipEventListeners = bindEventHandlers({
        eventSource,
        eventNames: buildEventList({ eventTypes: getEventTypes(context) }),
        onEvent: handleEvent,
    });
}

function init() {
    registerSettingsPanel();
    registerLauncher();
    registerPipEventListeners();
    initializeDesktopBridge();
    installDesktopComposerSync();
    installDesktopMutationObserver();
    startDesktopSyncHeartbeat();
    startLauncherRetry();
}

const context = getContext();
const eventTypes = getEventTypes(context);
if (context?.eventSource?.on) {
    context.eventSource.on(eventTypes.APP_READY ?? 'app_ready', init);
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
