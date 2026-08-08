const LOCAL_BRIDGE_HOSTS = new Set([
    '127.0.0.1',
    'localhost',
    '[::1]',
]);

const DESKTOP_ACTION_TYPES = new Set([
    'composer:update',
    'composer:send',
    'generation:retry',
    'generation:stop',
    'interaction:select',
    'interaction:input',
    'render:resync',
]);

export const MAX_DESKTOP_MESSAGE_BYTES = 14 * 1024 * 1024;
const LEGACY_DESKTOP_MESSAGE_BYTES = 1_500_000;

export const DESKTOP_BRIDGE_SETTINGS_KEY = 'pip-mini-chat-desktop-bridge-settings';

export const DEFAULT_DESKTOP_BRIDGE_SETTINGS = Object.freeze({
    enabled: false,
    url: 'ws://127.0.0.1:17864/bridge',
    token: '',
});

function normalizeLocalWebSocketUrl(value) {
    try {
        const url = new URL(String(value || DEFAULT_DESKTOP_BRIDGE_SETTINGS.url));
        if (!['ws:', 'wss:'].includes(url.protocol) || !LOCAL_BRIDGE_HOSTS.has(url.hostname)) {
            return DEFAULT_DESKTOP_BRIDGE_SETTINGS.url;
        }

        url.username = '';
        url.password = '';
        url.hash = '';
        url.searchParams.delete('token');
        if (!url.pathname || url.pathname === '/') {
            url.pathname = '/bridge';
        }
        return url.toString().replace(/\/$/, '');
    } catch {
        return DEFAULT_DESKTOP_BRIDGE_SETTINGS.url;
    }
}

export function normalizeDesktopBridgeSettings(value = {}) {
    return {
        enabled: Boolean(value.enabled),
        url: normalizeLocalWebSocketUrl(value.url),
        token: String(value.token || '').trim().slice(0, 256),
    };
}

export function parseDesktopBridgeConfiguration(value, current = DEFAULT_DESKTOP_BRIDGE_SETTINGS) {
    const text = String(value || '').trim();
    if (!text) {
        throw new Error('请先粘贴隐窗伴侣中的连接配置。');
    }

    let patch;
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('连接配置必须是对象。');
        }
        patch = {
            url: parsed.url,
            token: parsed.token,
        };
    } catch (error) {
        if (text.startsWith('{')) {
            throw new Error('连接配置 JSON 格式不正确。');
        }

        patch = text.startsWith('ws://') || text.startsWith('wss://')
            ? { url: text }
            : { token: text };
    }

    const normalized = normalizeDesktopBridgeSettings({
        ...current,
        ...patch,
        enabled: true,
    });

    if (!normalized.token) {
        throw new Error('连接配置中缺少令牌。');
    }

    return normalized;
}

export function buildDesktopBridgeConnectionUrl(settings) {
    const normalized = normalizeDesktopBridgeSettings(settings);
    const url = new URL(normalized.url);
    url.searchParams.set('token', normalized.token);
    return url.toString();
}

export function getDesktopBridgeStatusText(status) {
    const labels = {
        disabled: '未启用',
        'needs-config': '需要连接配置',
        connecting: '正在连接',
        waiting: '等待隐窗伴侣',
        connected: '已连接',
        error: '连接异常',
    };

    return labels[status?.state] || '未启用';
}

function getUtf8ByteLength(value) {
    if (typeof TextEncoder === 'function') {
        return new TextEncoder().encode(value).byteLength;
    }

    return new Blob([value]).size;
}

function encodeBridgeMessage(
    type,
    payload,
    logger = console,
    maximumBytes = LEGACY_DESKTOP_MESSAGE_BYTES,
) {
    let encoded = JSON.stringify({ type, payload });
    if (getUtf8ByteLength(encoded) <= maximumBytes) {
        return encoded;
    }

    if (type !== 'render:update') {
        logger.warn?.('[pip-mini-chat] Desktop bridge message is too large and was skipped.');
        return null;
    }

    encoded = JSON.stringify({
        type,
        payload: {
            documentId: String(payload?.documentId || '').slice(0, 200),
            revision: Number.isSafeInteger(payload?.revision) ? payload.revision : 0,
            title: String(payload?.title || 'SillyTavern').slice(0, 200),
            html: '',
            text: String(payload?.text || '渲染界面过大，已切换为原始文字。').slice(0, 200_000),
            streaming: Boolean(payload?.streaming),
            themeVariables: {},
        },
    });
    logger.warn?.('[pip-mini-chat] Render payload exceeded the local limit; text fallback was sent.');
    return encoded;
}

export class DesktopBridge {
    constructor({
        settings,
        WebSocketImpl = globalThis.WebSocket,
        getRenderPayload,
        getGenerationState,
        onAction,
        onStatus,
        logger = console,
    } = {}) {
        this.settings = normalizeDesktopBridgeSettings(settings);
        this.WebSocketImpl = WebSocketImpl;
        this.getRenderPayload = getRenderPayload;
        this.getGenerationState = getGenerationState;
        this.onAction = onAction;
        this.onStatus = onStatus;
        this.logger = logger;
        this.socket = null;
        this.connectionId = 0;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.syncTimer = null;
        this.lastRenderFingerprint = '';
        this.remoteMaxPayloadBytes = LEGACY_DESKTOP_MESSAGE_BYTES;
        this.status = {
            state: 'disabled',
            detail: '',
        };
    }

    start() {
        if (!this.settings.enabled) {
            this.setStatus('disabled');
            return;
        }

        this.connect();
    }

    setSettings(settings) {
        const previous = this.settings;
        this.settings = normalizeDesktopBridgeSettings(settings);
        const connectionChanged = previous.enabled !== this.settings.enabled
            || previous.url !== this.settings.url
            || previous.token !== this.settings.token;

        if (!this.settings.enabled) {
            this.disconnect('disabled');
            return;
        }

        if (connectionChanged || !this.socket) {
            this.connect();
        }
    }

    connect() {
        this.disconnectSocket();
        this.clearReconnectTimer();
        this.remoteMaxPayloadBytes = LEGACY_DESKTOP_MESSAGE_BYTES;

        if (!this.settings.enabled) {
            this.setStatus('disabled');
            return;
        }
        if (!this.settings.token) {
            this.setStatus('needs-config', '请粘贴隐窗伴侣的连接配置。');
            return;
        }
        if (typeof this.WebSocketImpl !== 'function') {
            this.setStatus('error', '当前浏览器不支持 WebSocket。');
            return;
        }

        const connectionId = ++this.connectionId;
        let socket;
        try {
            socket = new this.WebSocketImpl(buildDesktopBridgeConnectionUrl(this.settings));
        } catch (error) {
            this.setStatus('error', error.message);
            this.scheduleReconnect();
            return;
        }

        this.socket = socket;
        this.setStatus('connecting');

        socket.addEventListener('open', () => {
            if (connectionId !== this.connectionId || socket !== this.socket) {
                return;
            }

            this.reconnectAttempt = 0;
            this.setStatus('connected');
            this.send('bridge:hello', {
                protocolVersion: 1,
                plugin: '隐蔽小窗',
            });
            this.sendGenerationState();
        });

        socket.addEventListener('message', event => {
            if (connectionId !== this.connectionId || socket !== this.socket) {
                return;
            }
            void this.handleMessage(event.data);
        });

        socket.addEventListener('close', () => {
            if (connectionId !== this.connectionId || socket !== this.socket) {
                return;
            }

            this.socket = null;
            if (this.settings.enabled) {
                this.setStatus('waiting');
                this.scheduleReconnect();
            } else {
                this.setStatus('disabled');
            }
        });

        socket.addEventListener('error', () => {
            if (connectionId === this.connectionId && socket === this.socket) {
                this.setStatus('error', '无法连接本机隐窗伴侣。');
            }
        });
    }

    disconnect(status = 'disabled') {
        this.connectionId += 1;
        this.disconnectSocket();
        this.clearReconnectTimer();
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
        this.setStatus(status);
    }

    disconnectSocket() {
        const socket = this.socket;
        this.socket = null;
        if (socket && socket.readyState < 2) {
            socket.close(1000, 'Bridge reconnecting');
        }
    }

    clearReconnectTimer() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    scheduleReconnect() {
        if (!this.settings.enabled || this.reconnectTimer) {
            return;
        }

        const delay = Math.min(1000 * (2 ** this.reconnectAttempt), 10000);
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    setStatus(state, detail = '') {
        this.status = { state, detail };
        this.onStatus?.(this.status);
    }

    send(type, payload = {}) {
        if (!this.socket || this.socket.readyState !== 1) {
            return false;
        }

        try {
            const encoded = encodeBridgeMessage(
                type,
                payload,
                this.logger,
                this.remoteMaxPayloadBytes,
            );
            if (!encoded) {
                return false;
            }
            this.socket.send(encoded);
            return true;
        } catch (error) {
            this.logger.debug?.('[pip-mini-chat] Desktop bridge send failed', error);
            return false;
        }
    }

    sync(force = false) {
        if (!this.socket || this.socket.readyState !== 1 || typeof this.getRenderPayload !== 'function') {
            return false;
        }

        try {
            const payload = this.getRenderPayload();
            const fingerprint = JSON.stringify(payload);
            if (!force && fingerprint === this.lastRenderFingerprint) {
                return false;
            }

            const sent = this.send('render:update', payload);
            if (sent) {
                this.lastRenderFingerprint = fingerprint;
            }
            return sent;
        } catch (error) {
            this.logger.debug?.('[pip-mini-chat] Desktop render sync failed', error);
            return false;
        }
    }

    scheduleSync(delay = 100) {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            this.sync();
        }, delay);
    }

    sendGenerationState() {
        if (typeof this.getGenerationState !== 'function') {
            return false;
        }

        return this.send('generation:state', {
            generating: Boolean(this.getGenerationState()),
        });
    }

    async handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(String(raw));
        } catch {
            return;
        }

        if (message.type === 'bridge:ready') {
            const advertisedMaximum = Number(message.payload?.maxPayloadBytes);
            if (Number.isFinite(advertisedMaximum) && advertisedMaximum > 0) {
                this.remoteMaxPayloadBytes = Math.min(
                    MAX_DESKTOP_MESSAGE_BYTES,
                    Math.max(LEGACY_DESKTOP_MESSAGE_BYTES, advertisedMaximum - 65_536),
                );
            }
            this.setStatus('connected');
            this.sendGenerationState();
            this.sync(true);
            return;
        }
        if (message.type === 'bridge:error') {
            this.setStatus('error', String(message.payload?.message || '通信协议错误'));
            return;
        }
        if (message.type === 'pong' || !DESKTOP_ACTION_TYPES.has(message.type)) {
            return;
        }

        try {
            const result = await this.onAction?.({
                type: message.type,
                payload: message.payload || {},
            });
            if (typeof result?.composerText === 'string') {
                this.send('composer:update', {
                    text: result.composerText,
                });
            }
            if (!result?.skipGenerationState) {
                this.sendGenerationState();
            }
            if (!result?.skipRenderSync) {
                this.scheduleSync(30);
            }
        } catch (error) {
            this.logger.error?.('[pip-mini-chat] Desktop action failed', error);
        }
    }
}
