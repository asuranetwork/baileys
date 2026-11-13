"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeMessagesSocket = void 0;
const crypto_1 = require("crypto");
const node_cache_1 = __importDefault(require("@cacheable/node-cache"));
const boom_1 = require("@hapi/boom");
const index_mjs_1 = require("../../WAProto/index.mjs");
const index_js_1 = require("../Defaults/index.js");
const index_js_2 = require("../Utils/index.js");
const link_preview_js_1 = require("../Utils/link-preview.js");
const make_mutex_js_1 = require("../Utils/make-mutex.js");
const reporting_utils_js_1 = require("../Utils/reporting-utils.js");
const tc_token_utils_js_1 = require("../Utils/tc-token-utils.js");
const index_js_3 = require("../WABinary/index.js");
const index_js_4 = require("../WAUSync/index.js");
const newsletter_js_1 = require("./newsletter.js");
const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata, enableRecentMessageCache, maxMsgRetryCount } = config;
    const sock = (0, newsletter_js_1.makeNewsletterSocket)(config);
    const { ev, authState, messageMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral, registerSocketEndHandler } = sock;
    const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
    /**
     * Set of tctoken storage JIDs with a fire-and-forget `issuePrivacyTokens` IQ in flight.
     * Prevents duplicate IQs from rapid back-to-back sends before `senderTimestamp` persists.
     * Entries are always removed in `.finally()`, so the set is bounded by concurrency.
     */
    const inFlightTcTokenIssuance = new Set();
    const userDevicesCache = config.userDevicesCache ||
        new node_cache_1.default({
            stdTTL: index_js_1.DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
            useClones: false
        });
    /** Serializes writes to userDevicesCache across USync refresh and device-notification handling. */
    const devicesMutex = (0, make_mutex_js_1.makeMutex)();
    const messageRetryManager = enableRecentMessageCache ? new index_js_2.MessageRetryManager(logger, maxMsgRetryCount) : null;
    const encryptionMutex = (0, make_mutex_js_1.makeKeyedMutex)();
    let mediaConn;
    /** Per-socket media host; updated whenever media_conn is fetched. Defaults to the public WhatsApp host. */
    let mediaHost = index_js_2.DEF_MEDIA_HOST;
    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn;
        if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: index_js_3.S_WHATSAPP_NET
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                });
                const mediaConnNode = (0, index_js_3.getBinaryNodeChild)(result, 'media_conn');
                const node = {
                    hosts: (0, index_js_3.getBinaryNodeChildren)(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                };
                logger.debug('fetched media conn');
                if (node.hosts[0]) {
                    mediaHost = node.hosts[0].hostname;
                }
                return node;
            })();
        }
        return mediaConn;
    };
    /**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (!messageIds || messageIds.length === 0) {
            throw new boom_1.Boom('missing ids in receipt');
        }
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0]
            }
        };
        const isReadReceipt = type === 'read' || type === 'read-self';
        if (isReadReceipt) {
            node.attrs.t = (0, index_js_2.unixTimestampSeconds)().toString();
        }
        if (type === 'sender' && ((0, index_js_3.isPnUser)(jid) || (0, index_js_3.isLidUser)(jid))) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }
        if (type) {
            node.attrs.type = type;
        }
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ];
        }
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
        await sendNode(node);
    };
    /** Correctly bulk send receipts to multiple chats, participants */
    const sendReceipts = async (keys, type) => {
        const recps = (0, index_js_2.aggregateMessageKeysNotFromMe)(keys);
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    };
    /** Bulk read messages. Keys can be from different chats & participants */
    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings();
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
        await sendReceipts(keys, readType);
    };
    /** Fetch all the devices we've to send a message to */
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = [];
        if (!useCache) {
            logger.debug('not using cache for devices');
        }
        const toFetch = [];
        const jidsWithUser = jids
            .map(jid => {
            const decoded = (0, index_js_3.jidDecode)(jid);
            const user = decoded?.user;
            const device = decoded?.device;
            const isExplicitDevice = typeof device === 'number' && device >= 0;
            if (isExplicitDevice && user) {
                deviceResults.push({
                    user,
                    device,
                    jid
                });
                return null;
            }
            jid = (0, index_js_3.jidNormalizedUser)(jid);
            return { jid, user };
        })
            .filter(jid => jid !== null);
        let mgetDevices;
        if (useCache && userDevicesCache.mget) {
            const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean);
            mgetDevices = await userDevicesCache.mget(usersToFetch);
        }
        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] ||
                    (userDevicesCache.mget ? undefined : (await userDevicesCache.get(user)));
                if (devices) {
                    const devicesWithJid = devices.map(d => ({
                        ...d,
                        jid: (0, index_js_3.jidEncode)(d.user, d.server, d.device)
                    }));
                    deviceResults.push(...devicesWithJid);
                    logger.trace({ user }, 'using cache for devices');
                }
                else {
                    toFetch.push(jid);
                }
            }
            else {
                toFetch.push(jid);
            }
        }
        if (!toFetch.length) {
            return deviceResults;
        }
        const requestedLidUsers = new Set();
        for (const jid of toFetch) {
            if ((0, index_js_3.isLidUser)(jid) || (0, index_js_3.isHostedLidUser)(jid)) {
                const user = (0, index_js_3.jidDecode)(jid)?.user;
                if (user)
                    requestedLidUsers.add(user);
            }
        }
        const query = new index_js_4.USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol();
        for (const jid of toFetch) {
            query.withUser(new index_js_4.USyncUser().withId(jid)); // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
        }
        const result = await sock.executeUSyncQuery(query);
        if (result) {
            const lidResults = result.list.filter(a => !!a.lid);
            if (lidResults.length > 0) {
                logger.trace('Storing LID maps from device call');
                await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid, pn: a.id })));
                try {
                    const lids = lidResults.map(a => a.lid);
                    if (lids.length) {
                        await assertSessions(lids, true);
                    }
                }
                catch (e) {
                    logger.warn({ e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs');
                }
            }
            const extracted = (0, index_js_2.extractDeviceJids)(result?.list, authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices);
            const deviceMap = {};
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || [];
                deviceMap[item.user]?.push(item);
            }
            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user);
                for (const item of userDevices) {
                    const finalJid = isLidUser
                        ? (0, index_js_3.jidEncode)(user, item.server, item.device)
                        : (0, index_js_3.jidEncode)(item.user, item.server, item.device);
                    deviceResults.push({
                        ...item,
                        jid: finalJid
                    });
                    logger.debug({
                        user: item.user,
                        device: item.device,
                        finalJid,
                        usedLid: isLidUser
                    }, 'Processed device with LID priority');
                }
            }
            await devicesMutex.mutex(async () => {
                if (userDevicesCache.mset) {
                    await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })));
                }
                else {
                    for (const key in deviceMap) {
                        if (deviceMap[key])
                            await userDevicesCache.set(key, deviceMap[key]);
                    }
                }
            });
            const userDeviceUpdates = {};
            for (const [userId, devices] of Object.entries(deviceMap)) {
                if (devices && devices.length > 0) {
                    userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0');
                }
            }
            if (Object.keys(userDeviceUpdates).length > 0) {
                try {
                    await authState.keys.set({ 'device-list': userDeviceUpdates });
                    logger.debug({ userCount: Object.keys(userDeviceUpdates).length }, 'stored user device lists for bulk migration');
                }
                catch (error) {
                    logger.warn({ error }, 'failed to store user device lists');
                }
            }
        }
        return deviceResults;
    };
    /**
     * Update Member Label
     */
    const updateMemberLabel = (jid, memberLabel) => {
        return relayMessage(jid, {
            protocolMessage: {
                type: index_mjs_1.proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
                memberLabel: {
                    label: memberLabel?.slice(0, 30),
                    labelTimestamp: (0, index_js_2.unixTimestampSeconds)()
                }
            }
        }, {
            additionalNodes: [
                {
                    tag: 'meta',
                    attrs: {
                        tag_reason: 'user_update',
                        appdata: 'member_tag'
                    },
                    content: undefined
                }
            ]
        });
    };
    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        const uniqueJids = [...new Set(jids)];
        const jidsRequiringFetch = [];
        logger.debug({ jids }, 'assertSessions call with jids');
        for (const jid of uniqueJids) {
            if (!force) {
                const sessionValidation = await signalRepository.validateSession(jid);
                if (sessionValidation.exists) {
                    continue;
                }
            }
            jidsRequiringFetch.push(jid);
        }
        if (jidsRequiringFetch.length) {
            const wireJids = [
                ...jidsRequiringFetch.filter(jid => !!(0, index_js_3.isLidUser)(jid) || !!(0, index_js_3.isHostedLidUser)(jid)),
                ...((await signalRepository.lidMapping.getLIDsForPNs(jidsRequiringFetch.filter(jid => !!(0, index_js_3.isPnUser)(jid) || !!(0, index_js_3.isHostedPnUser)(jid)))) || []).map(a => a.lid)
            ];
            logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: index_js_3.S_WHATSAPP_NET
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: wireJids.map(jid => {
                            const attrs = { jid };
                            if (force)
                                attrs.reason = 'identity';
                            return { tag: 'user', attrs };
                        })
                    }
                ]
            });
            await (0, index_js_2.parseAndInjectE2ESessions)(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated');
        }
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: index_mjs_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        const meJid = (0, index_js_3.jidNormalizedUser)(authState.creds.me.id);
        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                push_priority: 'high_force'
            },
            additionalNodes: [
                {
                    tag: 'meta',
                    attrs: { appdata: 'default' }
                }
            ]
        });
        return msgId;
    };
    const createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
        if (!recipientJids.length) {
            return { nodes: [], shouldIncludeDeviceIdentity: false };
        }
        const patched = await patchMessageBeforeSending(message, recipientJids);
        const patchedMessages = Array.isArray(patched)
            ? patched
            : recipientJids.map(jid => ({ recipientJid: jid, message: patched }));
        let shouldIncludeDeviceIdentity = false;
        const meId = authState.creds.me.id;
        const meLid = authState.creds.me?.lid;
        const meLidUser = meLid ? (0, index_js_3.jidDecode)(meLid)?.user : null;
        const encryptionPromises = patchedMessages.map(async ({ recipientJid: jid, message: patchedMessage }) => {
            try {
                if (!jid)
                    return null;
                let msgToEncrypt = patchedMessage;
                if (dsmMessage) {
                    const { user: targetUser } = (0, index_js_3.jidDecode)(jid);
                    const { user: ownPnUser } = (0, index_js_3.jidDecode)(meId);
                    const ownLidUser = meLidUser;
                    const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser);
                    const isExactSenderDevice = jid === meId || (meLid && jid === meLid);
                    if (isOwnUser && !isExactSenderDevice) {
                        msgToEncrypt = dsmMessage;
                        logger.debug({ jid, targetUser }, 'Using DSM for own device');
                    }
                }
                const bytes = (0, index_js_2.encodeWAMessage)(msgToEncrypt);
                const mutexKey = jid;
                const node = await encryptionMutex.mutex(mutexKey, async () => {
                    const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes });
                    if (type === 'pkmsg') {
                        shouldIncludeDeviceIdentity = true;
                    }
                    return {
                        tag: 'to',
                        attrs: { jid },
                        content: [
                            {
                                tag: 'enc',
                                attrs: { v: '2', type, ...(extraAttrs || {}) },
                                content: ciphertext
                            }
                        ]
                    };
                });
                return node;
            }
            catch (err) {
                logger.error({ jid, err }, 'Failed to encrypt for recipient');
                return null;
            }
        });
        const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null);
        if (recipientJids.length > 0 && nodes.length === 0) {
            throw new boom_1.Boom('All encryptions failed', { statusCode: 500 });
        }
        return { nodes, shouldIncludeDeviceIdentity };
    };
    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, ai, useUserDevicesCache, useCachedGroupMetadata, statusJidList }) => {
        const relayContent = (0, index_js_2.normalizeMessageContent)(message) || message;
        const interactive = relayContent.interactiveMessage;
        const nativeFlowButtons = interactive?.nativeFlowMessage?.buttons || [];
        const legacyNativeFlowButtons = relayContent.buttonsMessage?.buttons || [];
        const nativeFlowNames = [
            ...nativeFlowButtons.map(button => button.name),
            ...legacyNativeFlowButtons.map(button => button.nativeFlowInfo?.name)
        ].filter((name) => !!name);
        const automaticNodes = [];
        const isDirectMessage = (0, index_js_3.isJidGroup)(jid) || (0, index_js_3.isPnUser)(jid) || (0, index_js_3.isLidUser)(jid) || (0, index_js_3.isHostedPnUser)(jid) || (0, index_js_3.isHostedLidUser)(jid);
        const hasCustomBizNode = (additionalNodes || []).some(node => node.tag === 'biz');
        const hasCustomPollMeta = (additionalNodes || []).some(node => node.tag === 'meta' && node.attrs?.polltype === 'creation');
        const hasCustomEventMeta = (additionalNodes || []).some(node => node.tag === 'meta' && node.attrs?.event_type === 'creation');
        const hasCustomBotNode = (additionalNodes || []).some(node => node.tag === 'bot');
        if (isDirectMessage && !hasCustomBizNode) {
            if (nativeFlowNames.includes('payment_key_info')) {
                automaticNodes.push({
                    tag: 'biz', attrs: {}, content: [{
                            tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
                            content: [{ tag: 'native_flow', attrs: { name: 'payment_key_info' } }]
                        }]
                });
            }
            else if (relayContent.productMessage) {
                automaticNodes.push({ tag: 'biz', attrs: { native_flow_name: 'catalog_message' } });
            }
            else if (relayContent.orderMessage) {
                automaticNodes.push({ tag: 'biz', attrs: { native_flow_name: 'order_details' } });
            }
            else if (interactive || relayContent.buttonsMessage) {
                automaticNodes.push({
                    tag: 'biz', attrs: {}, content: [{
                            tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
                            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
                        }]
                });
            }
            else if (relayContent.listMessage) {
                automaticNodes.push({ tag: 'biz', attrs: {}, content: [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }] });
            }
        }
        if (!hasCustomPollMeta && (relayContent.pollCreationMessage || relayContent.pollCreationMessageV2 || relayContent.pollCreationMessageV3 || relayContent.pollCreationMessageV5)) {
            automaticNodes.push({ tag: 'meta', attrs: { polltype: 'creation' } });
        }
        else if (!hasCustomEventMeta && relayContent.eventMessage) {
            automaticNodes.push({ tag: 'meta', attrs: { event_type: 'creation' } });
        }
        if (ai && !hasCustomBotNode) {
            automaticNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
            if (!hasCustomBizNode && isDirectMessage)
                automaticNodes.push({ tag: 'biz', attrs: {} });
        }
        const mergedNodes = [...(additionalNodes || []), ...automaticNodes];
        const seenNodes = new Set();
        additionalNodes = mergedNodes.filter(node => {
            const key = JSON.stringify(node);
            if (seenNodes.has(key))
                return false;
            seenNodes.add(key);
            return true;
        });
        const meId = (0, index_js_2.assertMeId)(authState.creds);
        const meLid = authState.creds.me?.lid;
        const isRetryResend = Boolean(participant?.jid);
        let shouldIncludeDeviceIdentity = isRetryResend;
        const statusJid = 'status@broadcast';
        const { user, server } = (0, index_js_3.jidDecode)(jid);
        const isGroup = server === 'g.us';
        const isStatus = jid === statusJid;
        const isLid = server === 'lid';
        const isNewsletter = server === 'newsletter';
        const isGroupOrStatus = isGroup || isStatus;
        const finalJid = jid;
        msgId = msgId || (0, index_js_2.generateMessageIDV2)(meId);
        useUserDevicesCache = useUserDevicesCache !== false;
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus;
        const participants = [];
        const destinationJid = !isStatus ? finalJid : statusJid;
        const binaryNodeContent = [];
        const devices = [];
        let reportingMessage;
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            },
            messageContextInfo: message.messageContextInfo
        };
        const extraAttrs = {};
        if (participant) {
            if (!isGroup && !isStatus) {
                additionalAttributes = { ...additionalAttributes, device_fanout: 'false' };
            }
            const { user, device } = (0, index_js_3.jidDecode)(participant.jid);
            devices.push({
                user,
                device,
                jid: participant.jid
            });
        }
        await authState.keys.transaction(async () => {
            const mediaType = getMediaType(message);
            if (mediaType) {
                extraAttrs['mediatype'] = mediaType;
            }
            if (isNewsletter) {
                const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message;
                const bytes = (0, index_js_2.encodeNewsletterMessage)(patched);
                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: {},
                    content: bytes
                });
                const stanza = {
                    tag: 'message',
                    attrs: {
                        to: jid,
                        id: msgId,
                        type: getMessageType(message),
                        ...(additionalAttributes || {})
                    },
                    content: binaryNodeContent
                };
                logger.debug({ msgId }, `sending newsletter message to ${jid}`);
                await sendNode(stanza);
                return;
            }
            if ((0, index_js_2.normalizeMessageContent)(message)?.pinInChatMessage || (0, index_js_2.normalizeMessageContent)(message)?.reactionMessage) {
                extraAttrs['decrypt-fail'] = 'hide'; // todo: expand for reactions and other types
            }
            if (isGroupOrStatus && !isRetryResend) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined; // todo: should we rely on the cache specially if the cache is outdated and the metadata has new fields?
                        if (groupData && Array.isArray(groupData?.participants)) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        }
                        else if (!isStatus) {
                            groupData = await groupMetadata(jid); // TODO: start storing group participant list + addr mode in Signal & stop relying on this
                        }
                        return groupData;
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [jid]); // TODO: check out what if the sender key memory doesn't include the LID stuff now?
                            return result[jid] || {};
                        }
                        return {};
                    })()
                ]);
                const participantsList = groupData ? groupData.participants.map(p => p.id) : [];
                if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
                    additionalAttributes = {
                        ...additionalAttributes,
                        expiration: groupData.ephemeralDuration.toString()
                    };
                }
                if (isStatus && statusJidList) {
                    participantsList.push(...statusJidList);
                }
                const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                devices.push(...additionalDevices);
                if (isGroup) {
                    additionalAttributes = {
                        ...additionalAttributes,
                        addressing_mode: groupData?.addressingMode || 'lid'
                    };
                }
                const patched = await patchMessageBeforeSending(message);
                if (Array.isArray(patched)) {
                    throw new boom_1.Boom('Per-jid patching is not supported in groups');
                }
                const bytes = (0, index_js_2.encodeWAMessage)(patched);
                reportingMessage = patched;
                const groupAddressingMode = additionalAttributes?.['addressing_mode'] || groupData?.addressingMode || 'lid';
                const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId;
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId: groupSenderIdentity
                });
                const senderKeyRecipients = [];
                for (const device of devices) {
                    const deviceJid = device.jid;
                    const hasKey = !!senderKeyMap[deviceJid];
                    if ((!hasKey || !!participant) &&
                        !(0, index_js_3.isHostedLidUser)(deviceJid) &&
                        !(0, index_js_3.isHostedPnUser)(deviceJid) &&
                        device.device !== 99) {
                        senderKeyRecipients.push(deviceJid);
                        senderKeyMap[deviceJid] = true;
                    }
                }
                if (senderKeyRecipients.length) {
                    logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key');
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    const senderKeySessionTargets = senderKeyRecipients;
                    await assertSessions(senderKeySessionTargets);
                    const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs);
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg', ...extraAttrs },
                    content: ciphertext
                });
                await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
            }
            else {
                let ownId = meId;
                if (isLid && meLid) {
                    ownId = meLid;
                    logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation');
                }
                else {
                    logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation');
                }
                const { user: ownUser } = (0, index_js_3.jidDecode)(ownId);
                if (!participant) {
                    const patchedForReporting = await patchMessageBeforeSending(message, [jid]);
                    reportingMessage = Array.isArray(patchedForReporting)
                        ? patchedForReporting.find(item => item.recipientJid === jid) || patchedForReporting[0]
                        : patchedForReporting;
                }
                if (!isRetryResend) {
                    const targetUserServer = isLid ? 'lid' : 's.whatsapp.net';
                    devices.push({
                        user,
                        device: 0,
                        jid: (0, index_js_3.jidEncode)(user, targetUserServer, 0) // rajeh, todo: this entire logic is convoluted and weird.
                    });
                    if (user !== ownUser) {
                        const ownUserServer = isLid ? 'lid' : 's.whatsapp.net';
                        const ownUserForAddressing = isLid && meLid ? (0, index_js_3.jidDecode)(meLid).user : (0, index_js_3.jidDecode)(meId).user;
                        devices.push({
                            user: ownUserForAddressing,
                            device: 0,
                            jid: (0, index_js_3.jidEncode)(ownUserForAddressing, ownUserServer, 0)
                        });
                    }
                    if (additionalAttributes?.['category'] !== 'peer') {
                        devices.length = 0;
                        const senderIdentity = isLid && meLid
                            ? (0, index_js_3.jidEncode)((0, index_js_3.jidDecode)(meLid)?.user, 'lid', undefined)
                            : (0, index_js_3.jidEncode)((0, index_js_3.jidDecode)(meId)?.user, 's.whatsapp.net', undefined);
                        const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false);
                        devices.push(...sessionDevices);
                        logger.debug({
                            deviceCount: devices.length,
                            devices: devices.map(d => `${d.user}:${d.device}@${(0, index_js_3.jidDecode)(d.jid)?.server}`)
                        }, 'Device enumeration complete with unified addressing');
                    }
                }
                const allRecipients = [];
                const meRecipients = [];
                const otherRecipients = [];
                const { user: mePnUser } = (0, index_js_3.jidDecode)(meId);
                const { user: meLidUser } = meLid ? (0, index_js_3.jidDecode)(meLid) : { user: null };
                for (const { user, jid } of devices) {
                    const isExactSenderDevice = jid === meId || (meLid && jid === meLid);
                    if (isExactSenderDevice) {
                        logger.debug({ jid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)');
                        continue;
                    }
                    const isMe = user === mePnUser || user === meLidUser;
                    if (isMe) {
                        meRecipients.push(jid);
                    }
                    else {
                        otherRecipients.push(jid);
                    }
                    allRecipients.push(jid);
                }
                await assertSessions(allRecipients);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meRecipients, meMsg || message, extraAttrs),
                    createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)
                ]);
                participants.push(...meNodes);
                participants.push(...otherNodes);
                if (meRecipients.length > 0 || otherRecipients.length > 0) {
                    extraAttrs['phash'] = (0, index_js_2.generateParticipantHashV2)([...meRecipients, ...otherRecipients]);
                }
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (isRetryResend) {
                const isParticipantLid = (0, index_js_3.isLidUser)(participant.jid);
                const isMe = (0, index_js_3.areJidsSameUser)(participant.jid, isParticipantLid ? meLid : meId);
                let messageToSend = message;
                if (isGroupOrStatus) {
                    let groupSenderIdentity;
                    if (meLid && (await signalRepository.hasSenderKey({ group: destinationJid, meId: meLid }))) {
                        groupSenderIdentity = meLid;
                    }
                    else if (await signalRepository.hasSenderKey({ group: destinationJid, meId })) {
                        groupSenderIdentity = meId;
                    }
                    if (groupSenderIdentity) {
                        try {
                            const skdm = await signalRepository.getSenderKeyDistributionMessage({
                                group: destinationJid,
                                meId: groupSenderIdentity
                            });
                            messageToSend = {
                                ...message,
                                senderKeyDistributionMessage: {
                                    groupId: destinationJid,
                                    axolotlSenderKeyDistributionMessage: skdm
                                }
                            };
                        }
                        catch (err) {
                            logger.warn({ err, jid: destinationJid }, 'failed to build SKDM for retry, sending without it');
                        }
                    }
                }
                const encodedMessageToSend = isMe
                    ? (0, index_js_2.encodeWAMessage)({
                        deviceSentMessage: {
                            destinationJid,
                            message: messageToSend
                        }
                    })
                    : (0, index_js_2.encodeWAMessage)(messageToSend);
                const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({
                    data: encodedMessageToSend,
                    jid: participant.jid
                });
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: {
                        v: '2',
                        type,
                        count: participant.count.toString()
                    },
                    content: encryptedContent
                });
            }
            if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                    const peerNode = participants[0]?.content?.[0];
                    if (peerNode) {
                        binaryNodeContent.push(peerNode); // push only enc
                    }
                }
                else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    });
                }
            }
            const stanza = {
                tag: 'message',
                attrs: {
                    id: msgId,
                    to: destinationJid,
                    type: getMessageType(message),
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            };
            if (participant) {
                if ((0, index_js_3.isJidGroup)(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if ((0, index_js_3.areJidsSameUser)(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                }
                else {
                    stanza.attrs.to = participant.jid;
                }
            }
            else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                ;
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: (0, index_js_2.encodeSignedDeviceIdentity)(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
            if (!isNewsletter &&
                !isRetryResend &&
                reportingMessage?.messageContextInfo?.messageSecret &&
                (0, reporting_utils_js_1.shouldIncludeReportingToken)(reportingMessage)) {
                try {
                    const encoded = (0, index_js_2.encodeWAMessage)(reportingMessage);
                    const reportingKey = {
                        id: msgId,
                        fromMe: true,
                        remoteJid: destinationJid,
                        participant: participant?.jid
                    };
                    const reportingNode = await (0, reporting_utils_js_1.getMessageReportingToken)(encoded, reportingMessage, reportingKey);
                    if (reportingNode) {
                        ;
                        stanza.content.push(reportingNode);
                        logger.trace({ jid }, 'added reporting token to message');
                    }
                }
                catch (error) {
                    logger.warn({ jid, trace: error?.stack }, 'failed to attach reporting token');
                }
            }
            const isPeerMessage = additionalAttributes?.['category'] === 'peer';
            const is1on1Send = !isGroup && !isRetryResend && !isStatus && !isNewsletter && !isPeerMessage;
            const tcTokenJid = is1on1Send ? await (0, tc_token_utils_js_1.resolveTcTokenJid)(destinationJid, getLIDForPN) : destinationJid;
            const contactTcTokenData = is1on1Send ? await authState.keys.get('tctoken', [tcTokenJid]) : {};
            const existingTokenEntry = contactTcTokenData[tcTokenJid];
            let tcTokenBuffer = existingTokenEntry?.token;
            if (tcTokenBuffer?.length && (0, tc_token_utils_js_1.isTcTokenExpired)(existingTokenEntry?.timestamp)) {
                logger.debug({ jid: destinationJid, timestamp: existingTokenEntry?.timestamp }, 'tctoken expired, clearing');
                tcTokenBuffer = undefined;
                const cleared = existingTokenEntry?.senderTimestamp !== undefined
                    ? { token: Buffer.alloc(0), senderTimestamp: existingTokenEntry.senderTimestamp }
                    : null;
                try {
                    await authState.keys.set({ tctoken: { [tcTokenJid]: cleared } });
                }
                catch (err) {
                    logger.debug({ jid: destinationJid, err: err?.message }, 'failed to persist tctoken expiry cleanup');
                }
            }
            if (tcTokenBuffer?.length && sock.serverProps.privacyTokenOn1to1) {
                ;
                stanza.content.push({
                    tag: 'tctoken',
                    attrs: {},
                    content: tcTokenBuffer
                });
            }
            if (additionalNodes && additionalNodes.length > 0) {
                ;
                stanza.content.push(...additionalNodes);
            }
            logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            await sendNode(stanza);
            const isProtocolMsg = !!(0, index_js_2.normalizeMessageContent)(message)?.protocolMessage;
            const isBotOrPSA = destinationJid === index_js_3.PSA_WID || (0, index_js_3.isJidBot)(destinationJid) || (0, index_js_3.isJidMetaAI)(destinationJid);
            if (is1on1Send &&
                !isProtocolMsg &&
                !isBotOrPSA &&
                (0, tc_token_utils_js_1.shouldSendNewTcToken)(existingTokenEntry?.senderTimestamp) &&
                !inFlightTcTokenIssuance.has(tcTokenJid)) {
                inFlightTcTokenIssuance.add(tcTokenJid);
                const issueTimestamp = (0, index_js_2.unixTimestampSeconds)();
                const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
                (0, tc_token_utils_js_1.resolveIssuanceJid)(destinationJid, sock.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID)
                    .then(issueJid => issuePrivacyTokens([issueJid], issueTimestamp))
                    .then(async (result) => {
                    await (0, tc_token_utils_js_1.storeTcTokensFromIqResult)({
                        result,
                        fallbackJid: tcTokenJid,
                        keys: authState.keys,
                        getLIDForPN
                    });
                    const currentData = await authState.keys.get('tctoken', [tcTokenJid]);
                    const currentEntry = currentData[tcTokenJid];
                    const indexWrite = await (0, tc_token_utils_js_1.buildMergedTcTokenIndexWrite)(authState.keys, [tcTokenJid]);
                    await authState.keys.set({
                        tctoken: {
                            [tcTokenJid]: {
                                token: Buffer.alloc(0),
                                ...currentEntry,
                                senderTimestamp: issueTimestamp
                            },
                            ...indexWrite
                        }
                    });
                })
                    .catch(err => {
                    logger.debug({ jid: destinationJid, err: err?.message }, 'fire-and-forget tctoken issuance failed');
                })
                    .finally(() => {
                    inFlightTcTokenIssuance.delete(tcTokenJid);
                });
            }
            if (messageRetryManager && !participant) {
                messageRetryManager.addRecentMessage(destinationJid, msgId, message);
            }
        }, meId);
        return msgId;
    };
    const getMessageType = (message) => {
        const normalizedMessage = (0, index_js_2.normalizeMessageContent)(message);
        if (!normalizedMessage)
            return 'text';
        if (normalizedMessage.reactionMessage || normalizedMessage.encReactionMessage) {
            return 'reaction';
        }
        if (normalizedMessage.pollCreationMessage ||
            normalizedMessage.pollCreationMessageV2 ||
            normalizedMessage.pollCreationMessageV3 ||
            normalizedMessage.pollUpdateMessage) {
            return 'poll';
        }
        if (normalizedMessage.eventMessage) {
            return 'event';
        }
        if (getMediaType(normalizedMessage) !== '') {
            return 'media';
        }
        return 'text';
    };
    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image';
        }
        else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video';
        }
        else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio';
        }
        else if (message.contactMessage) {
            return 'vcard';
        }
        else if (message.documentMessage) {
            return 'document';
        }
        else if (message.contactsArrayMessage) {
            return 'contact_array';
        }
        else if (message.liveLocationMessage) {
            return 'livelocation';
        }
        else if (message.stickerMessage) {
            return 'sticker';
        }
        else if (message.listMessage) {
            return 'list';
        }
        else if (message.listResponseMessage) {
            return 'list_response';
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response';
        }
        else if (message.orderMessage) {
            return 'order';
        }
        else if (message.productMessage) {
            return 'product';
        }
        else if (message.interactiveResponseMessage) {
            return 'native_flow_response';
        }
        else if (message.groupInviteMessage) {
            return 'url';
        }
        return '';
    };
    /**
     * Do not remove this watermark.
     *
     * NIXCODE - Advanced WhatsApp Send Private Relay
     *
     * Runtime:
     * - Baileys: @lepzsync/baileys
     *
     * Created by Nixel
     * WhatsApp: wa.me/6285188349341
     * Channel: https://whatsapp.com/channel/0029VbCV1ck8fewpdNb2TY2k
     *
     * Copyright (c) 2026 Nixel
     *
     * Permission is granted to use and modify this library
     * for personal or commercial projects.
     * Reuploading, reselling, relicensing, or redistributing
     * this library as a standalone product is prohibited.
     * Do not claim this project as your own original work.
     */
    const sendPrivateRelay = async (jid, message, { messageId: providedMessageId, additionalAttributes, additionalNodes, ai, useUserDevicesCache, useCachedGroupMetadata, statusJidList, mode = 'exclude', target = [], targetMe, hideDecryptFail = true, deviceMode = 'all' } = {}) => {
        if (!message || typeof message !== 'object') {
            throw new boom_1.Boom('A valid proto.IMessage is required', { statusCode: 400 });
        }
        if (mode !== 'include' && mode !== 'exclude') {
            throw new boom_1.Boom(`Invalid private relay mode: ${String(mode)}`, { statusCode: 400 });
        }
        if (!['all', 'primary', 'secondary'].includes(deviceMode)) {
            throw new boom_1.Boom(`Invalid deviceMode: ${String(deviceMode)}`, { statusCode: 400 });
        }
        const meId = (0, index_js_2.assertMeId)(authState.creds);
        const meLid = authState.creds.me?.lid;
        const decodedDestination = (0, index_js_3.jidDecode)(jid);
        if (!decodedDestination?.user || !decodedDestination.server) {
            throw new boom_1.Boom(`Invalid destination JID: ${jid}`, { statusCode: 400 });
        }
        const { user, server } = decodedDestination;
        const isNewsletter = server === 'newsletter';
        const isGroup = server === 'g.us';
        const statusJid = 'status@broadcast';
        const isStatus = jid === statusJid;
        const isGroupOrStatus = isGroup || isStatus;
        const destinationJid = isStatus ? statusJid : jid;
        const msgId = providedMessageId || (0, index_js_2.generateMessageIDV2)(meId);
        const useCache = useUserDevicesCache !== false;
        const useGroupCache = useCachedGroupMetadata !== false && !isStatus;
        const binaryNodeContent = [];
        const participants = [];
        const devices = [];
        const extraAttrs = {};
        let shouldIncludeDeviceIdentity = false;
        let reportingMessage;
        if (hideDecryptFail)
            extraAttrs['decrypt-fail'] = 'hide';
        const normalizedMessage = (0, index_js_2.normalizeMessageContent)(message) || message;
        const interactive = normalizedMessage.interactiveMessage;
        const nativeFlowButtons = interactive?.nativeFlowMessage?.buttons || [];
        const legacyNativeFlowButtons = normalizedMessage.buttonsMessage?.buttons || [];
        const nativeFlowNames = [
            ...nativeFlowButtons.map(button => button.name),
            ...legacyNativeFlowButtons.map(button => button.nativeFlowInfo?.name)
        ].filter((name) => !!name);
        const automaticNodes = [];
        const isDirectMessage = (0, index_js_3.isJidGroup)(jid) || (0, index_js_3.isPnUser)(jid) || (0, index_js_3.isLidUser)(jid) || (0, index_js_3.isHostedPnUser)(jid) || (0, index_js_3.isHostedLidUser)(jid);
        const hasCustomBizNode = (additionalNodes || []).some(node => node.tag === 'biz');
        const hasCustomPollMeta = (additionalNodes || []).some(node => node.tag === 'meta' && node.attrs?.polltype === 'creation');
        const hasCustomEventMeta = (additionalNodes || []).some(node => node.tag === 'meta' && node.attrs?.event_type === 'creation');
        const hasCustomBotNode = (additionalNodes || []).some(node => node.tag === 'bot');
        if (isDirectMessage && !hasCustomBizNode) {
            if (nativeFlowNames.includes('payment_key_info')) {
                automaticNodes.push({
                    tag: 'biz', attrs: {}, content: [{
                            tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
                            content: [{ tag: 'native_flow', attrs: { name: 'payment_key_info' } }]
                        }]
                });
            }
            else if (normalizedMessage.productMessage) {
                automaticNodes.push({ tag: 'biz', attrs: { native_flow_name: 'catalog_message' } });
            }
            else if (normalizedMessage.orderMessage) {
                automaticNodes.push({ tag: 'biz', attrs: { native_flow_name: 'order_details' } });
            }
            else if (interactive || normalizedMessage.buttonsMessage) {
                automaticNodes.push({
                    tag: 'biz', attrs: {}, content: [{
                            tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
                            content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
                        }]
                });
            }
            else if (normalizedMessage.listMessage) {
                automaticNodes.push({ tag: 'biz', attrs: {}, content: [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }] });
            }
        }
        if (!hasCustomPollMeta && (normalizedMessage.pollCreationMessage || normalizedMessage.pollCreationMessageV2 || normalizedMessage.pollCreationMessageV3 || normalizedMessage.pollCreationMessageV5)) {
            automaticNodes.push({ tag: 'meta', attrs: { polltype: 'creation' } });
        }
        else if (!hasCustomEventMeta && normalizedMessage.eventMessage) {
            automaticNodes.push({ tag: 'meta', attrs: { event_type: 'creation' } });
        }
        if (ai && !hasCustomBotNode) {
            automaticNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
            if (!hasCustomBizNode && isDirectMessage)
                automaticNodes.push({ tag: 'biz', attrs: {} });
        }
        const mergedNodes = [...(additionalNodes || []), ...automaticNodes];
        const seenNodes = new Set();
        additionalNodes = mergedNodes.filter(node => {
            const key = JSON.stringify(node);
            if (seenNodes.has(key))
                return false;
            seenNodes.add(key);
            return true;
        });
        const mediaType = getMediaType(normalizedMessage);
        if (mediaType)
            extraAttrs['mediatype'] = mediaType;
        if (normalizedMessage.pinInChatMessage || normalizedMessage.reactionMessage) {
            extraAttrs['decrypt-fail'] = 'hide';
        }
        const normalizeTargetJid = (value) => {
            const trimmed = String(value || '').trim();
            if (!trimmed)
                return undefined;
            if (trimmed.includes('@'))
                return trimmed;
            const digits = trimmed.replace(/[^0-9]/g, '');
            return digits ? `${digits}@s.whatsapp.net` : undefined;
        };
        const targetRules = [];
        for (const rawTarget of Array.isArray(target) ? target : []) {
            const normalizedTarget = normalizeTargetJid(rawTarget);
            if (!normalizedTarget)
                continue;
            const decodedTarget = (0, index_js_3.jidDecode)(normalizedTarget);
            if (!decodedTarget?.user || !decodedTarget.server)
                continue;
            const hasExplicitDevice = normalizedTarget.includes(':');
            const targetDevice = hasExplicitDevice ? decodedTarget.device ?? 0 : null;
            targetRules.push({ user: decodedTarget.user, server: decodedTarget.server, device: targetDevice });
            try {
                if (decodedTarget.server === 's.whatsapp.net') {
                    const lidJid = await signalRepository.lidMapping.getLIDForPN(normalizedTarget);
                    const lidDecoded = lidJid ? (0, index_js_3.jidDecode)(lidJid) : undefined;
                    if (lidDecoded?.user && lidDecoded.server) {
                        targetRules.push({ user: lidDecoded.user, server: lidDecoded.server, device: targetDevice });
                    }
                }
                else if (decodedTarget.server === 'lid') {
                    const pnJid = await signalRepository.lidMapping.getPNForLID(normalizedTarget);
                    const pnDecoded = pnJid ? (0, index_js_3.jidDecode)(pnJid) : undefined;
                    if (pnDecoded?.user && pnDecoded.server) {
                        targetRules.push({ user: pnDecoded.user, server: pnDecoded.server, device: targetDevice });
                    }
                }
            }
            catch (error) {
                logger.debug({ target: normalizedTarget, error }, 'private relay PN/LID target mapping skipped');
            }
        }
        const isTargetMatch = (targetJid, rules = targetRules) => {
            const decoded = (0, index_js_3.jidDecode)(targetJid);
            if (!decoded?.user || !decoded.server)
                return false;
            const targetDevice = decoded.device ?? 0;
            return rules.some(rule => rule.user === decoded.user &&
                rule.server === decoded.server &&
                (rule.device === null || rule.device === targetDevice));
        };
        const refreshTargetMappingRules = async () => {
            for (const rawTarget of Array.isArray(target) ? target : []) {
                const normalizedTarget = normalizeTargetJid(rawTarget);
                if (!normalizedTarget)
                    continue;
                const decodedTarget = (0, index_js_3.jidDecode)(normalizedTarget);
                if (!decodedTarget?.user || !decodedTarget.server)
                    continue;
                const targetDevice = normalizedTarget.includes(':') ? decodedTarget.device ?? 0 : null;
                try {
                    const alias = decodedTarget.server === 's.whatsapp.net'
                        ? await signalRepository.lidMapping.getLIDForPN(normalizedTarget)
                        : decodedTarget.server === 'lid'
                            ? await signalRepository.lidMapping.getPNForLID(normalizedTarget)
                            : undefined;
                    const aliasDecoded = alias ? (0, index_js_3.jidDecode)(alias) : undefined;
                    if (aliasDecoded?.user && aliasDecoded.server) {
                        targetRules.push({ user: aliasDecoded.user, server: aliasDecoded.server, device: targetDevice });
                    }
                }
                catch (error) {
                    logger.debug({ target: normalizedTarget, error }, 'private relay refreshed PN/LID mapping skipped');
                }
            }
        };
        const shouldSendToDevice = (device) => {
            const decoded = (0, index_js_3.jidDecode)(device.jid);
            if (!decoded?.user)
                return false;
            const matches = isTargetMatch(device.jid);
            let include = mode === 'include' ? matches : !matches;
            const mePnUser = (0, index_js_3.jidDecode)(meId)?.user;
            const meLidUser = meLid ? (0, index_js_3.jidDecode)(meLid)?.user : undefined;
            const isOwnDevice = device.user === mePnUser || device.user === meLidUser || decoded.user === mePnUser || decoded.user === meLidUser;
            if (isOwnDevice && typeof targetMe === 'boolean')
                include = targetMe;
            const deviceId = decoded.device ?? device.device ?? 0;
            if (deviceMode === 'primary' && deviceId !== 0)
                include = false;
            if (deviceMode === 'secondary' && deviceId === 0)
                include = false;
            return include;
        };
        await authState.keys.transaction(async () => {
            if (isNewsletter) {
                const patched = await patchMessageBeforeSending(message, []);
                const bytes = (0, index_js_2.encodeNewsletterMessage)(patched);
                binaryNodeContent.push({ tag: 'plaintext', attrs: {}, content: bytes });
                await sendNode({
                    tag: 'message',
                    attrs: { to: jid, id: msgId, type: getMessageType(message), ...(additionalAttributes || {}) },
                    content: binaryNodeContent
                });
                return;
            }
            if (isGroupOrStatus) {
                let groupData = useGroupCache && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined;
                if (!(groupData && Array.isArray(groupData.participants)) && !isStatus) {
                    groupData = await groupMetadata(jid);
                }
                const participantsList = groupData?.participants.map(participant => participant.id).filter(Boolean) || [];
                if (isStatus) {
                    if (!statusJidList?.length) {
                        throw new boom_1.Boom('statusJidList is required for status@broadcast private relay', { statusCode: 400 });
                    }
                    participantsList.push(...statusJidList);
                }
                if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
                    additionalAttributes = { ...additionalAttributes, expiration: groupData.ephemeralDuration.toString() };
                }
                if (isGroup) {
                    additionalAttributes = { ...additionalAttributes, addressing_mode: groupData?.addressingMode || 'lid' };
                }
                devices.push(...(await getUSyncDevices(participantsList, useCache, false)));
                await refreshTargetMappingRules();
                if (isGroup && groupData?.participants?.length && targetRules.length) {
                    for (const participant of groupData.participants) {
                        const aliases = [participant.id, participant.lid, participant.phoneNumber, participant.pn]
                            .filter((value) => typeof value === 'string' && !!value);
                        const matchingRules = targetRules.filter(rule => aliases.some(alias => {
                            const decodedAlias = (0, index_js_3.jidDecode)(alias);
                            return decodedAlias?.user === rule.user && decodedAlias.server === rule.server;
                        }));
                        for (const rule of matchingRules) {
                            for (const alias of aliases) {
                                const decodedAlias = (0, index_js_3.jidDecode)(alias);
                                if (decodedAlias?.user && decodedAlias.server) {
                                    targetRules.push({ user: decodedAlias.user, server: decodedAlias.server, device: rule.device });
                                }
                            }
                        }
                    }
                }
                const senderKeyRecipients = [...new Set(devices
                        .filter(device => shouldSendToDevice(device) &&
                        !(0, index_js_3.isHostedLidUser)(device.jid) &&
                        !(0, index_js_3.isHostedPnUser)(device.jid) &&
                        device.device !== 99)
                        .map(device => device.jid))];
                if (!senderKeyRecipients.length) {
                    throw new boom_1.Boom('Private relay selected zero eligible group devices. Check mode, target and deviceMode.', { statusCode: 400 });
                }
                const patched = await patchMessageBeforeSending(message);
                if (Array.isArray(patched)) {
                    throw new boom_1.Boom('Per-jid patching is not supported in groups', { statusCode: 400 });
                }
                reportingMessage = patched;
                const bytes = (0, index_js_2.encodeWAMessage)(patched);
                const groupAddressingMode = additionalAttributes?.['addressing_mode'] || groupData?.addressingMode || 'lid';
                const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId;
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId: groupSenderIdentity,
                    resetSenderKey: true
                });
                const senderKeyMessage = {
                    senderKeyDistributionMessage: {
                        groupId: destinationJid,
                        axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage
                    }
                };
                await assertSessions(senderKeyRecipients);
                const skdmResult = await createParticipantNodes(senderKeyRecipients, senderKeyMessage, extraAttrs);
                participants.push(...skdmResult.nodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || skdmResult.shouldIncludeDeviceIdentity;
                binaryNodeContent.push({ tag: 'enc', attrs: { v: '2', type: 'skmsg', ...extraAttrs }, content: ciphertext });
            }
            else {
                const isLid = server === 'lid';
                const ownId = isLid && meLid ? meLid : meId;
                const ownUser = (0, index_js_3.jidDecode)(ownId)?.user;
                const targetServer = isLid ? 'lid' : 's.whatsapp.net';
                devices.push({ user, device: 0, jid: (0, index_js_3.jidEncode)(user, targetServer, 0) });
                if (user !== ownUser) {
                    const ownUserForAddressing = isLid && meLid ? (0, index_js_3.jidDecode)(meLid).user : (0, index_js_3.jidDecode)(meId).user;
                    devices.push({ user: ownUserForAddressing, device: 0, jid: (0, index_js_3.jidEncode)(ownUserForAddressing, targetServer, 0) });
                }
                if (additionalAttributes?.['category'] !== 'peer') {
                    devices.length = 0;
                    const senderIdentity = isLid && meLid
                        ? (0, index_js_3.jidEncode)((0, index_js_3.jidDecode)(meLid).user, 'lid', undefined)
                        : (0, index_js_3.jidEncode)((0, index_js_3.jidDecode)(meId).user, 's.whatsapp.net', undefined);
                    devices.push(...(await getUSyncDevices([senderIdentity, jid], useCache, false)));
                }
                await refreshTargetMappingRules();
                const mePnUser = (0, index_js_3.jidDecode)(meId)?.user;
                const meLidUser = meLid ? (0, index_js_3.jidDecode)(meLid)?.user : undefined;
                const meRecipients = [];
                const otherRecipients = [];
                for (const device of devices) {
                    const deviceJid = device.jid;
                    if (deviceJid === meId || (meLid && deviceJid === meLid))
                        continue;
                    if (!shouldSendToDevice(device))
                        continue;
                    const isMe = device.user === mePnUser || device.user === meLidUser;
                    if (isMe)
                        meRecipients.push(deviceJid);
                    else
                        otherRecipients.push(deviceJid);
                }
                const allRecipients = [...new Set([...meRecipients, ...otherRecipients])];
                if (!allRecipients.length) {
                    throw new boom_1.Boom('Private relay selected zero eligible devices. Check mode, target and deviceMode.', { statusCode: 400 });
                }
                const patchedForReporting = await patchMessageBeforeSending(message, [jid]);
                reportingMessage = Array.isArray(patchedForReporting)
                    ? patchedForReporting.find(item => item.recipientJid === jid) || patchedForReporting[0]
                    : patchedForReporting;
                await assertSessions(allRecipients);
                const [meResult, otherResult] = await Promise.all([
                    createParticipantNodes(meRecipients, meMsgForPrivateRelay(destinationJid, message), extraAttrs),
                    createParticipantNodes(otherRecipients, message, extraAttrs, meMsgForPrivateRelay(destinationJid, message))
                ]);
                participants.push(...meResult.nodes, ...otherResult.nodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || meResult.shouldIncludeDeviceIdentity || otherResult.shouldIncludeDeviceIdentity;
                if (allRecipients.length)
                    extraAttrs['phash'] = (0, index_js_2.generateParticipantHashV2)(allRecipients);
            }
            if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                    const peerNode = participants[0]?.content?.[0];
                    if (peerNode)
                        binaryNodeContent.push(peerNode);
                }
                else {
                    binaryNodeContent.push({ tag: 'participants', attrs: {}, content: participants });
                }
            }
            const stanza = {
                tag: 'message',
                attrs: { id: msgId, to: destinationJid, type: getMessageType(message), ...(additionalAttributes || {}) },
                content: binaryNodeContent
            };
            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({ tag: 'device-identity', attrs: {}, content: (0, index_js_2.encodeSignedDeviceIdentity)(authState.creds.account, true) });
            }
            if (!isStatus && reportingMessage?.messageContextInfo?.messageSecret &&
                (0, reporting_utils_js_1.shouldIncludeReportingToken)(reportingMessage) &&
                !(additionalNodes || []).some(node => node.tag === 'reporting')) {
                try {
                    const reportingNode = await (0, reporting_utils_js_1.getMessageReportingToken)((0, index_js_2.encodeWAMessage)(reportingMessage), reportingMessage, {
                        id: msgId,
                        fromMe: true,
                        remoteJid: destinationJid
                    });
                    if (reportingNode)
                        stanza.content.push(reportingNode);
                }
                catch (error) {
                    logger.warn({ jid, error }, 'private relay reporting token generation failed');
                }
            }
            const isPeerMessage = additionalAttributes?.['category'] === 'peer';
            if (!isGroup && !isStatus && !isPeerMessage && sock.serverProps.privacyTokenOn1to1) {
                const tcTokenJid = await (0, tc_token_utils_js_1.resolveTcTokenJid)(destinationJid, getLIDForPN);
                const tokenData = await authState.keys.get('tctoken', [tcTokenJid]);
                const tokenEntry = tokenData[tcTokenJid];
                if (tokenEntry?.token?.length && !(0, tc_token_utils_js_1.isTcTokenExpired)(tokenEntry.timestamp)) {
                    stanza.content.push({ tag: 'tctoken', attrs: {}, content: tokenEntry.token });
                }
            }
            if (additionalNodes?.length)
                stanza.content.push(...additionalNodes);
            await sendNode(stanza);
        }, meId);
        return msgId;
    };
    const meMsgForPrivateRelay = (destinationJid, message) => ({
        deviceSentMessage: { destinationJid, message },
        messageContextInfo: message.messageContextInfo
    });
    const issuePrivacyTokens = async (jids, timestamp) => {
        const t = (timestamp ?? (0, index_js_2.unixTimestampSeconds)()).toString();
        const result = await query({
            tag: 'iq',
            attrs: {
                to: index_js_3.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: (0, index_js_3.jidNormalizedUser)(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        });
        return result;
    };
    const waUploadToServer = (0, index_js_2.getWAUploadToServer)(config, refreshMediaConn);
    const waitForMsgMediaUpdate = (0, index_js_2.bindWaitForEvent)(ev, 'messages.media-update');
    registerSocketEndHandler(() => {
        if (!config.userDevicesCache && userDevicesCache.close) {
            userDevicesCache.close();
        }
        mediaConn = undefined;
        if (messageRetryManager) {
            messageRetryManager.clear();
        }
    });
    return {
        ...sock,
        userDevicesCache,
        devicesMutex,
        issuePrivacyTokens,
        assertSessions,
        relayMessage,
        sendPrivateRelay,
        sendReceipt,
        sendReceipts,
        readMessages,
        refreshMediaConn,
        getMediaHost: () => mediaHost,
        waUploadToServer,
        fetchPrivacySettings,
        sendPeerDataOperationMessage,
        createParticipantNodes,
        getUSyncDevices,
        messageRetryManager,
        updateMemberLabel,
        updateMediaMessage: async (message) => {
            const content = (0, index_js_2.assertMediaContent)(message.message);
            const mediaKey = content.mediaKey;
            const meId = authState.creds.me.id;
            const node = (0, index_js_2.encryptMediaRetryRequest)(message.key, mediaKey, meId);
            let error = undefined;
            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find(c => c.key.id === message.key.id);
                    if (result) {
                        if (result.error) {
                            error = result.error;
                        }
                        else {
                            try {
                                const media = (0, index_js_2.decryptMediaRetryData)(result.media, mediaKey, result.key.id);
                                if (media.result !== index_mjs_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = index_mjs_1.proto.MediaRetryNotification.ResultType[media.result];
                                    throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, {
                                        data: media,
                                        statusCode: (0, index_js_2.getStatusCodeForMediaRetry)(media.result) || 404
                                    });
                                }
                                content.directPath = media.directPath;
                                content.url = (0, index_js_2.getUrlFromDirectPath)(content.directPath, mediaHost);
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful');
                            }
                            catch (err) {
                                error = err;
                            }
                        }
                        return true;
                    }
                })
            ]);
            if (error) {
                throw error;
            }
            ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }]);
            return message;
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id;
            if (typeof content === 'object' &&
                'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' &&
                (0, index_js_3.isJidGroup)(jid)) {
                const { disappearingMessagesInChat } = content;
                const value = typeof disappearingMessagesInChat === 'boolean'
                    ? disappearingMessagesInChat
                        ? index_js_1.WA_DEFAULT_EPHEMERAL
                        : 0
                    : disappearingMessagesInChat;
                await groupToggleEphemeral(jid, value);
            }
            else {
                if (typeof content === 'object' && content !== null && 'photoPoll' in content) {
                    const photoPoll = content.photoPoll;
                    if (!photoPoll.name || !Array.isArray(photoPoll.values) || photoPoll.values.length < 2) {
                        throw new Error('photoPoll membutuhkan name dan minimal 2 values');
                    }
                    const selectableCount = photoPoll.selectableCount ?? 1;
                    if (!Number.isInteger(selectableCount) || selectableCount < 1 || selectableCount > photoPoll.values.length) {
                        throw new Error(`photoPoll.selectableCount harus 1 sampai ${photoPoll.values.length}`);
                    }
                    const messageSecret = photoPoll.messageSecret ? Buffer.from(photoPoll.messageSecret) : (0, crypto_1.randomBytes)(32);
                    if (messageSecret.length !== 32)
                        throw new Error('photoPoll.messageSecret harus 32 byte');
                    const hashOption = (name, fileSha256) => (0, crypto_1.createHash)('sha256')
                        .update((0, crypto_1.createHash)('sha256').update(String(name)).digest('hex') + Buffer.from(fileSha256).toString('base64'))
                        .digest('hex');
                    const images = await Promise.all(photoPoll.values.map(async (item, index) => {
                        if (!item?.name || !item.image)
                            throw new Error(`photoPoll.values[${index}] harus memiliki name dan image`);
                        const { imageMessage } = await (0, index_js_2.prepareWAMessageMedia)({ image: item.image }, {
                            upload: waUploadToServer,
                            logger,
                            mediaCache: config.mediaCache,
                            options: config.options
                        });
                        if (!imageMessage?.fileSha256)
                            throw new Error(`Upload gambar photo poll gagal pada index ${index}`);
                        return { name: String(item.name), imageMessage, optionHash: hashOption(item.name, imageMessage.fileSha256) };
                    }));
                    const parent = (0, index_js_2.generateWAMessageFromContent)(jid, {
                        pollCreationMessageV3: {
                            name: photoPoll.name,
                            selectableOptionsCount: selectableCount,
                            options: images.map(({ name, optionHash }) => ({ optionName: name, optionHash })),
                            pollContentType: index_mjs_1.proto.Message.PollContentType.IMAGE
                        },
                        messageContextInfo: { messageSecret }
                    }, {
                        logger,
                        userJid,
                        messageId: options.messageId || (0, index_js_2.generateMessageIDV2)(sock.user?.id),
                        ...options
                    });
                    const parentKey = parent.key;
                    await relayMessage(jid, parent.message, {
                        messageId: parentKey.id,
                        useCachedGroupMetadata: options.useCachedGroupMetadata,
                        additionalNodes: [...(options.additionalNodes || []), { tag: 'meta', attrs: { polltype: 'creation', contenttype: 'image' } }]
                    });
                    for (const { imageMessage } of images) {
                        const child = index_mjs_1.proto.Message.create({
                            messageContextInfo: { messageAssociation: {
                                    parentMessageKey: parentKey,
                                    associationType: index_mjs_1.proto.MessageAssociation.AssociationType.MEDIA_POLL
                                } },
                            pollCreationOptionImageMessage: { message: { imageMessage } }
                        });
                        await relayMessage(jid, child, {
                            messageId: (0, crypto_1.randomUUID)(),
                            useCachedGroupMetadata: options.useCachedGroupMetadata,
                            additionalNodes: [{ tag: 'meta', attrs: { message_association_type: 'media_poll' } }]
                        });
                    }
                    return parent;
                }
                let messageContent = content;
                let buttonLocationMessage;
                if (typeof content === 'object' && content !== null && 'buttonLocation' in content) {
                    const buttonLocation = content.buttonLocation;
                    let imageBuffer;
                    if (typeof buttonLocation.thumbnail === 'string') {
                        const response = await fetch(buttonLocation.thumbnail);
                        if (!response.ok) {
                            throw new Error(`Gagal download gambar: ${response.status} ${response.statusText}`);
                        }
                        imageBuffer = Buffer.from(await response.arrayBuffer());
                    }
                    else {
                        imageBuffer = Buffer.from(buttonLocation.thumbnail);
                    }
                    let thumbnail;
                    try {
                        const jimpModule = await new Function('return import("jimp")')();
                        const Jimp = jimpModule.Jimp || jimpModule.default;
                        const image = await Jimp.read(imageBuffer);
                        image.resize({ w: 300, h: 300 });
                        thumbnail = Buffer.from(await image.getBuffer('image/jpeg'));
                    }
                    catch (error) {
                        throw new Error(`Gagal memproses thumbnail dengan Jimp: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    const buttons = buttonLocation.buttons.map(button => ({
                        buttonId: button.id,
                        buttonText: { displayText: button.text },
                        type: 1,
                        ...(button.type === 'single_select' ? {
                            nativeFlowInfo: {
                                name: 'single_select',
                                paramsJson: JSON.stringify(button.params || { title: button.text, sections: [] })
                            }
                        } : {})
                    }));
                    const rawMessage = index_mjs_1.proto.Message.fromObject({
                        buttonsMessage: {
                            contentText: buttonLocation.text,
                            footerText: buttonLocation.footer || '',
                            headerType: 6,
                            locationMessage: {
                                degreesLatitude: 0,
                                degreesLongitude: 0,
                                name: buttonLocation.title || buttonLocation.text,
                                address: buttonLocation.address || '',
                                jpegThumbnail: thumbnail
                            },
                            buttons
                        }
                    });
                    buttonLocationMessage = rawMessage;
                }
                const generationOptions = {
                    logger,
                    userJid,
                    getUrlInfo: text => (0, link_preview_js_1.getUrlInfo)(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3_000,
                            ...(httpRequestOptions || {})
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    getProfilePicUrl: sock.profilePictureUrl,
                    getCallLink: sock.createCallLink,
                    upload: waUploadToServer,
                    mediaCache: config.mediaCache,
                    options: config.options,
                    messageId: (0, index_js_2.generateMessageIDV2)(sock.user?.id),
                    ...options
                };
                const fullMsg = buttonLocationMessage
                    ? (0, index_js_2.generateWAMessageFromContent)(jid, buttonLocationMessage, generationOptions)
                    : await (0, index_js_2.generateWAMessage)(jid, messageContent, generationOptions);
                const isEventMsg = 'event' in content && !!content.event;
                const isDeleteMsg = 'delete' in content && !!content.delete;
                const isEditMsg = 'edit' in content && !!content.edit;
                const isPinMsg = 'pin' in content && !!content.pin;
                const isPollMessage = 'poll' in content && !!content.poll;
                const isAiMsg = 'ai' in content && !!content.ai;
                const additionalAttributes = {};
                const additionalNodes = [...(options.additionalNodes || [])];
                const outgoingContent = (0, index_js_2.normalizeMessageContent)(fullMsg.message) || fullMsg.message;
                const interactive = outgoingContent.interactiveMessage;
                const nativeFlowButtons = interactive?.nativeFlowMessage?.buttons || [];
                const legacyNativeFlowButtons = outgoingContent.buttonsMessage?.buttons || [];
                const nativeFlowNames = [
                    ...nativeFlowButtons.map(button => button.name),
                    ...legacyNativeFlowButtons.map(button => button.nativeFlowInfo?.name)
                ].filter((name) => !!name);
                const hasPaymentKeyInfo = nativeFlowNames.includes('payment_key_info');
                const hasInteractive = !!(interactive || outgoingContent.buttonsMessage);
                const hasList = !!outgoingContent.listMessage;
                const hasCatalog = !!outgoingContent.productMessage;
                const hasOrder = !!outgoingContent.orderMessage;
                if (isDeleteMsg) {
                    if ((0, index_js_3.isJidGroup)(content.delete?.remoteJid) && !content.delete?.fromMe) {
                        additionalAttributes.edit = '8';
                    }
                    else {
                        additionalAttributes.edit = '7';
                    }
                }
                else if (isEditMsg) {
                    additionalAttributes.edit = '1';
                }
                else if (isPinMsg) {
                    additionalAttributes.edit = '2';
                }
                else if (isPollMessage || outgoingContent.pollCreationMessage || outgoingContent.pollCreationMessageV2 || outgoingContent.pollCreationMessageV3 || outgoingContent.pollCreationMessageV5) {
                    additionalNodes.push({ tag: 'meta', attrs: { polltype: 'creation' } });
                }
                else if (isEventMsg || outgoingContent.eventMessage) {
                    additionalNodes.push({ tag: 'meta', attrs: { event_type: 'creation' } });
                }
                if (hasPaymentKeyInfo) {
                    additionalNodes.push({ tag: 'biz', attrs: {}, content: [{
                                tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
                                content: [{ tag: 'native_flow', attrs: { name: 'payment_key_info' } }]
                            }] });
                }
                else if (hasCatalog) {
                    additionalNodes.push({ tag: 'biz', attrs: { native_flow_name: 'catalog_message' } });
                }
                else if (hasOrder) {
                    additionalNodes.push({ tag: 'biz', attrs: { native_flow_name: 'order_details' } });
                }
                else if (hasInteractive) {
                    additionalNodes.push({ tag: 'biz', attrs: {}, content: [{
                                tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
                                content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
                            }] });
                }
                else if (hasList) {
                    additionalNodes.push({ tag: 'biz', attrs: {}, content: [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }] });
                }
                if (isAiMsg) {
                    additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
                    additionalNodes.push({ tag: 'biz', attrs: {} });
                }
                await relayMessage(jid, fullMsg.message, {
                    messageId: fullMsg.key.id,
                    useCachedGroupMetadata: options.useCachedGroupMetadata,
                    additionalAttributes,
                    statusJidList: options.statusJidList,
                    additionalNodes,
                    ai: isAiMsg
                });
                const richEdit = content?.richMessage?.editrich;
                if (richEdit && typeof richEdit === 'object') {
                    const delay = Math.max(0, Number(richEdit.delay) || 0);
                    if (delay)
                        await new Promise(resolve => setTimeout(resolve, delay));
                    const { delay: _ignoredDelay, ...editedRichContent } = richEdit;
                    const editedMsg = await (0, index_js_2.generateWAMessage)(jid, { richMessage: editedRichContent }, generationOptions);
                    await relayMessage(jid, {
                        botForwardedMessage: {
                            message: {
                                protocolMessage: {
                                    key: { remoteJid: jid, fromMe: true, id: fullMsg.key.id },
                                    type: 14,
                                    editedMessage: editedMsg.message
                                }
                            }
                        }
                    }, { messageId: (0, crypto_1.randomUUID)() });
                }
                if (config.emitOwnEvents) {
                    process.nextTick(async () => {
                        await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'));
                    });
                }
                return fullMsg;
            }
        }
    };
};
exports.makeMessagesSocket = makeMessagesSocket;
