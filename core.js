export const EVENT_NAMES = Object.freeze({
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_RECEIVED: 'message_received',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    MESSAGE_SENT: 'message_sent',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
});

export const THEME_VARIABLE_NAMES = Object.freeze([
    '--SmartThemeBodyColor',
    '--SmartThemeEmColor',
    '--SmartThemeUnderlineColor',
    '--SmartThemeQuoteColor',
    '--SmartThemeBlurTintColor',
    '--SmartThemeChatTintColor',
    '--SmartThemeUserMesBlurTintColor',
    '--SmartThemeBotMesBlurTintColor',
    '--SmartThemeShadowColor',
    '--SmartThemeBorderColor',
    '--mainFontSize',
    '--black30a',
    '--black70a',
    '--grey30a',
    '--grey7070a',
    '--white30a',
    '--white50a',
]);

export function collectThemeVariables(styles, variableNames = THEME_VARIABLE_NAMES) {
    const variables = {};

    for (const name of variableNames) {
        const value = styles?.getPropertyValue?.(name)?.trim();
        if (value) {
            variables[name] = value;
        }
    }

    return variables;
}

export function buildThemeVariableCss(variables) {
    const declarations = Object.entries(variables ?? {})
        .map(([name, value]) => `${name}:${value};`)
        .join('');

    return declarations ? `:root{${declarations}}` : '';
}

export function findLatestAssistantMessage(chat) {
    if (!Array.isArray(chat)) {
        return null;
    }

    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (!message || message.is_user === true || message.is_system === true) {
            continue;
        }

        return { message, index };
    }

    return null;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function escapeAttribute(value) {
    return escapeHtml(value);
}

export function decodeHtmlEntities(value) {
    return String(value ?? '')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

export function unwrapHtmlCodeFence(value) {
    const text = String(value ?? '').trim();
    const match = text.match(/^```(?:html)?\s*\n([\s\S]*?)\n```$/i);
    return match ? match[1].trim() : String(value ?? '');
}

export function splitHtmlDocument(value) {
    const text = unwrapHtmlCodeFence(decodeHtmlEntities(value));
    const match = text.match(/(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/i);
    if (!match || match.index === undefined) {
        return null;
    }

    return {
        before: text.slice(0, match.index),
        document: text.slice(match.index).replace(/\n```$/g, '').trim(),
    };
}

export function getFirstTagContent(html, tagName) {
    const match = String(html ?? '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match ? match[1] : '';
}

export function getScriptTags(html) {
    return String(html ?? '').match(/<script\b[\s\S]*?<\/script>/gi) ?? [];
}

export function removeScriptTags(html) {
    return String(html ?? '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

export function getHeadRenderTags(html) {
    const head = getFirstTagContent(html, 'head');
    return (head.match(/<style\b[\s\S]*?<\/style>|<link\b[^>]*>/gi) ?? []).join('');
}

export function getBodyContent(html) {
    const body = getFirstTagContent(html, 'body');
    if (body) {
        return body;
    }

    return String(html ?? '')
        .replace(/<!doctype\s+html[^>]*>/i, '')
        .replace(/<html\b[^>]*>/i, '')
        .replace(/<\/html>/i, '')
        .replace(/<head\b[\s\S]*?<\/head>/i, '');
}

export function formatHtmlDocumentMessage(value) {
    const split = splitHtmlDocument(value);
    if (!split) {
        return null;
    }

    const before = split.before.trim()
        ? `${escapeHtml(split.before.trim()).replaceAll('\n', '<br>')}<br>`
        : '';
    const headTags = getHeadRenderTags(split.document);
    const bodyContent = removeScriptTags(getBodyContent(split.document));
    const scripts = getScriptTags(split.document).join('');

    return `${before}<div class="pip-mini-chat-html-document">${headTags}${bodyContent}${scripts}</div>`;
}

export function formatLatestAssistantMessage({ chat, formatter }) {
    const latest = findLatestAssistantMessage(chat);
    if (!latest) {
        return '<span class="pip-mini-chat-empty">暂无回复</span>';
    }

    const { message, index } = latest;
    const htmlDocument = formatHtmlDocumentMessage(message.mes);
    if (htmlDocument) {
        return htmlDocument;
    }

    if (typeof formatter === 'function') {
        return formatter(message.mes, message.name, false, false, index);
    }

    return escapeHtml(message.mes).replaceAll('\n', '<br>');
}

export async function sendDraftToSillyTavern({
    text,
    textarea,
    inputEventFactory,
    sendTextareaMessage,
    compatibleIntentTarget = null,
    compatibleIntentEventFactory = null,
}) {
    const draft = String(text ?? '').trim();
    if (!draft) {
        throw new Error('Cannot send an empty message.');
    }

    if (!textarea) {
        throw new Error('SillyTavern input textarea was not found.');
    }

    if (typeof sendTextareaMessage !== 'function') {
        throw new Error('SillyTavern sendTextareaMessage is unavailable.');
    }

    textarea.value = draft;
    textarea.dispatchEvent(inputEventFactory());
    signalCompatibleSendIntent({
        target: compatibleIntentTarget,
        eventFactory: compatibleIntentEventFactory,
    });
    await sendTextareaMessage();
}

export function signalCompatibleSendIntent({ target, eventFactory }) {
    if (!target || typeof target.dispatchEvent !== 'function' || typeof eventFactory !== 'function') {
        return false;
    }

    target.dispatchEvent(eventFactory());
    return true;
}

export function buildEventList({ eventTypes } = {}) {
    const types = eventTypes ?? {};
    const names = [
        types.CHAT_CHANGED ?? EVENT_NAMES.CHAT_CHANGED,
        types.MESSAGE_RECEIVED ?? EVENT_NAMES.MESSAGE_RECEIVED,
        types.GENERATION_ENDED ?? EVENT_NAMES.GENERATION_ENDED,
        types.CHARACTER_MESSAGE_RENDERED ?? EVENT_NAMES.CHARACTER_MESSAGE_RENDERED,
        types.MESSAGE_SENT ?? EVENT_NAMES.MESSAGE_SENT,
        types.STREAM_TOKEN_RECEIVED ?? EVENT_NAMES.STREAM_TOKEN_RECEIVED,
        types.GENERATION_STARTED ?? EVENT_NAMES.GENERATION_STARTED,
        types.GENERATION_STOPPED ?? EVENT_NAMES.GENERATION_STOPPED,
    ];

    return [...new Set(names.filter(Boolean))];
}

export function bindEventHandlers({ eventSource, eventNames, onEvent }) {
    if (!eventSource?.on || typeof onEvent !== 'function') {
        return () => {};
    }

    const bindings = [];
    for (const eventName of eventNames ?? []) {
        const handler = (...args) => onEvent(eventName, ...args);
        eventSource.on(eventName, handler);
        bindings.push([eventName, handler]);
    }

    return () => {
        for (const [eventName, handler] of bindings) {
            eventSource.removeListener?.(eventName, handler);
        }
    };
}

export function getLauncherTargets(doc) {
    const targets = [];
    const menu = doc?.querySelector?.('#extensionsMenu');

    if (menu) {
        targets.push({
            id: 'pip-mini-chat-menu-open',
            host: menu,
            variant: 'menu',
        });
    }

    if (doc?.body) {
        targets.push({
            id: 'pip-mini-chat-floating-open',
            host: doc.body,
            variant: 'floating',
        });
    }

    return targets;
}

export function normalizeFloatingPosition({
    left,
    top,
    viewportWidth,
    viewportHeight,
    elementWidth,
    elementHeight,
    margin = 8,
}) {
    const maxLeft = Math.max(margin, viewportWidth - elementWidth - margin);
    const maxTop = Math.max(margin, viewportHeight - elementHeight - margin);

    return {
        left: Math.min(Math.max(left, margin), maxLeft),
        top: Math.min(Math.max(top, margin), maxTop),
    };
}

export function getTextareaRowCount(value) {
    const lineCount = String(value ?? '').split('\n').length;
    return Math.min(Math.max(lineCount, 1), 3);
}

export async function triggerRegenerate(context) {
    if (typeof context?.generate !== 'function') {
        throw new Error('SillyTavern generate is unavailable.');
    }

    await context.generate('regenerate');
}

export function shouldClosePipWindow(pipWindow) {
    return Boolean(pipWindow && pipWindow.closed !== true);
}

export function readGenerationState({ localState, isGeneratingFn } = {}) {
    if (typeof isGeneratingFn !== 'function') {
        return Boolean(localState);
    }

    try {
        return Boolean(isGeneratingFn());
    } catch {
        return Boolean(localState);
    }
}

export function readBooleanSetting({ storage, key, fallback = false }) {
    try {
        const value = storage?.getItem?.(key);
        if (value === 'true') {
            return true;
        }
        if (value === 'false') {
            return false;
        }
    } catch {
        // Settings are optional; fall back when storage is unavailable.
    }

    return Boolean(fallback);
}

export function writeBooleanSetting({ storage, key, value }) {
    try {
        storage?.setItem?.(key, String(Boolean(value)));
        return true;
    } catch {
        return false;
    }
}
