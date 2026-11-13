import { createHash, randomBytes, randomUUID } from 'crypto';
import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.mjs';
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { aggregateMessageKeysNotFromMe, assertMediaContent, assertMeId, bindWaitForEvent, decryptMediaRetryData, DEF_MEDIA_HOST, encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest, extractDeviceJids, generateMessageIDV2, generateParticipantHashV2, generateWAMessage, generateWAMessageFromContent, getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, MessageRetryManager, normalizeMessageContent, parseAndInjectE2ESessions, prepareWAMessageMedia, unixTimestampSeconds } from '../Utils/index.js';
import { getUrlInfo } from '../Utils/link-preview.js';
import { makeKeyedMutex, makeMutex } from '../Utils/make-mutex.js';
import { getMessageReportingToken, shouldIncludeReportingToken } from '../Utils/reporting-utils.js';
import { buildMergedTcTokenIndexWrite, isTcTokenExpired, resolveIssuanceJid, resolveTcTokenJid, shouldSendNewTcToken, storeTcTokensFromIqResult } from '../Utils/tc-token-utils.js';
import { areJidsSameUser, getBinaryNodeChild, getBinaryNodeChildren, isHostedLidUser, isHostedPnUser, isJidBot, isJidGroup, isJidMetaAI, isLidUser, isPnUser, jidDecode, jidEncode, jidNormalizedUser, PSA_WID, S_WHATSAPP_NET } from '../WABinary/index.js';
import { USyncQuery, USyncUser } from '../WAUSync/index.js';
import { makeNewsletterSocket } from './newsletter.js';
export const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata, enableRecentMessageCache, maxMsgRetryCount } = config;
    const sock = makeNewsletterSocket(config);
    const { ev, authState, messageMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral, registerSocketEndHandler } = sock;
    const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
    /**
     * Set of tctoken storage JIDs with a fire-and-forget `issuePrivacyTokens` IQ in flight.
     * Prevents duplicate IQs from rapid back-to-back sends before `senderTimestamp` persists.
     * Entries are always removed in `.finally()`, so the set is bounded by concurrency.
     */
    const inFlightTcTokenIssuance = new Set();
    const userDevicesCache = config.userDevicesCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
            useClones: false
        });
    /** Serializes writes to userDevicesCache across USync refresh and device-notification handling. */
    const devicesMutex = makeMutex();
    const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null;
    const encryptionMutex = makeKeyedMutex();
    let mediaConn;
    /** Per-socket media host; updated whenever media_conn is fetched. Defaults to the public WhatsApp host. */
    let mediaHost = DEF_MEDIA_HOST;
    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn;
        if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: S_WHATSAPP_NET
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                });
                const mediaConnNode = getBinaryNodeChild(result, 'media_conn');
                const node = {
                    hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
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
            throw new Boom('missing ids in receipt');
        }
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0]
            }
        };
        const isReadReceipt = type === 'read' || type === 'read-self';
        if (isReadReceipt) {
            node.attrs.t = unixTimestampSeconds().toString();
        }
        if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
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
        const recps = aggregateMessageKeysNotFromMe(keys);
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
            const decoded = jidDecode(jid);
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
            jid = jidNormalizedUser(jid);
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
                        jid: jidEncode(d.user, d.server, d.device)
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
            if (isLidUser(jid) || isHostedLidUser(jid)) {
                const user = jidDecode(jid)?.user;
                if (user)
                    requestedLidUsers.add(user);
            }
        }
        const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol();
        for (const jid of toFetch) {
            query.withUser(new USyncUser().withId(jid)); // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
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
            const extracted = extractDeviceJids(result?.list, authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices);
            const deviceMap = {};
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || [];
                deviceMap[item.user]?.push(item);
            }
            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user);
                for (const item of userDevices) {
                    const finalJid = isLidUser
                        ? jidEncode(user, item.server, item.device)
                        : jidEncode(item.user, item.server, item.device);
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
                type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
                memberLabel: {
                    label: memberLabel?.slice(0, 30),
                    labelTimestamp: unixTimestampSeconds()
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
                ...jidsRequiringFetch.filter(jid => !!isLidUser(jid) || !!isHostedLidUser(jid)),
                ...((await signalRepository.lidMapping.getLIDsForPNs(jidsRequiringFetch.filter(jid => !!isPnUser(jid) || !!isHostedPnUser(jid)))) || []).map(a => a.lid)
            ];
            logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: S_WHATSAPP_NET
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
            await parseAndInjectE2ESessions(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        const meJid = jidNormalizedUser(authState.creds.me.id);
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
        const meLidUser = meLid ? jidDecode(meLid)?.user : null;
        const encryptionPromises = patchedMessages.map(async ({ recipientJid: jid, message: patchedMessage }) => {
            try {
                if (!jid)
                    return null;
                let msgToEncrypt = patchedMessage;
                if (dsmMessage) {
                    const { user: targetUser } = jidDecode(jid);
                    const { user: ownPnUser } = jidDecode(meId);
                    const ownLidUser = meLidUser;
                    const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser);
                    const isExactSenderDevice = jid === meId || (meLid && jid === meLid);
                    if (isOwnUser && !isExactSenderDevice) {
                        msgToEncrypt = dsmMessage;
                        logger.debug({ jid, targetUser }, 'Using DSM for own device');
                    }
                }
                const bytes = encodeWAMessage(msgToEncrypt);
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
            throw new Boom('All encryptions failed', { statusCode: 500 });
        }
        return { nodes, shouldIncludeDeviceIdentity };
    };
    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, ai, useUserDevicesCache, useCachedGroupMetadata, statusJidList }) => {
        const relayContent = normalizeMessageContent(message) || message;
        const interactive = relayContent.interactiveMessage;
        const nativeFlowButtons = interactive?.nativeFlowMessage?.buttons || [];
        const legacyNativeFlowButtons = relayContent.buttonsMessage?.buttons || [];
        const nativeFlowNames = [
            ...nativeFlowButtons.map(button => button.name),
            ...legacyNativeFlowButtons.map(button => button.nativeFlowInfo?.name)
        ].filter((name) => !!name);
        const automaticNodes = [];
        const isDirectMessage = isJidGroup(jid) || isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid);
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
        const meId = assertMeId(authState.creds);
        const meLid = authState.creds.me?.lid;
        const isRetryResend = Boolean(participant?.jid);
        let shouldIncludeDeviceIdentity = isRetryResend;
        const statusJid = 'status@broadcast';
        const { user, server } = jidDecode(jid);
        const isGroup = server === 'g.us';
        const isStatus = jid === statusJid;
        const isLid = server === 'lid';
        const isNewsletter = server === 'newsletter';
        const isGroupOrStatus = isGroup || isStatus;
        const finalJid = jid;
        msgId = msgId || generateMessageIDV2(meId);
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
            const { user, device } = jidDecode(participant.jid);
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
                const bytes = encodeNewsletterMessage(patched);
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
            if (normalizeMessageContent(message)?.pinInChatMessage || normalizeMessageContent(message)?.reactionMessage) {
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
                    throw new Boom('Per-jid patching is not supported in groups');
                }
                const bytes = encodeWAMessage(patched);
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
                        !isHostedLidUser(deviceJid) &&
                        !isHostedPnUser(deviceJid) &&
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
                const { user: ownUser } = jidDecode(ownId);
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
                        jid: jidEncode(user, targetUserServer, 0) // rajeh, todo: this entire logic is convoluted and weird.
                    });
                    if (user !== ownUser) {
                        const ownUserServer = isLid ? 'lid' : 's.whatsapp.net';
                        const ownUserForAddressing = isLid && meLid ? jidDecode(meLid).user : jidDecode(meId).user;
                        devices.push({
                            user: ownUserForAddressing,
                            device: 0,
                            jid: jidEncode(ownUserForAddressing, ownUserServer, 0)
                        });
                    }
                    if (additionalAttributes?.['category'] !== 'peer') {
                        devices.length = 0;
                        const senderIdentity = isLid && meLid
                            ? jidEncode(jidDecode(meLid)?.user, 'lid', undefined)
                            : jidEncode(jidDecode(meId)?.user, 's.whatsapp.net', undefined);
                        const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false);
                        devices.push(...sessionDevices);
                        logger.debug({
                            deviceCount: devices.length,
                            devices: devices.map(d => `${d.user}:${d.device}@${jidDecode(d.jid)?.server}`)
                        }, 'Device enumeration complete with unified addressing');
                    }
                }
                const allRecipients = [];
                const meRecipients = [];
                const otherRecipients = [];
                const { user: mePnUser } = jidDecode(meId);
                const { user: meLidUser } = meLid ? jidDecode(meLid) : { user: null };
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
                    extraAttrs['phash'] = generateParticipantHashV2([...meRecipients, ...otherRecipients]);
                }
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (isRetryResend) {
                const isParticipantLid = isLidUser(participant.jid);
                const isMe = areJidsSameUser(participant.jid, isParticipantLid ? meLid : meId);
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
                    ? encodeWAMessage({
                        deviceSentMessage: {
                            destinationJid,
                            message: messageToSend
                        }
                    })
                    : encodeWAMessage(messageToSend);
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
                if (isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if (areJidsSameUser(participant.jid, meId)) {
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
                    content: encodeSignedDeviceIdentity(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
            if (!isNewsletter &&
                !isRetryResend &&
                reportingMessage?.messageContextInfo?.messageSecret &&
                shouldIncludeReportingToken(reportingMessage)) {
                try {
                    const encoded = encodeWAMessage(reportingMessage);
                    const reportingKey = {
                        id: msgId,
                        fromMe: true,
                        remoteJid: destinationJid,
                        participant: participant?.jid
                    };
                    const reportingNode = await getMessageReportingToken(encoded, reportingMessage, reportingKey);
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
            const tcTokenJid = is1on1Send ? await resolveTcTokenJid(destinationJid, getLIDForPN) : destinationJid;
            const contactTcTokenData = is1on1Send ? await authState.keys.get('tctoken', [tcTokenJid]) : {};
            const existingTokenEntry = contactTcTokenData[tcTokenJid];
            let tcTokenBuffer = existingTokenEntry?.token;
            if (tcTokenBuffer?.length && isTcTokenExpired(existingTokenEntry?.timestamp)) {
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
            const isProtocolMsg = !!normalizeMessageContent(message)?.protocolMessage;
            const isBotOrPSA = destinationJid === PSA_WID || isJidBot(destinationJid) || isJidMetaAI(destinationJid);
            if (is1on1Send &&
                !isProtocolMsg &&
                !isBotOrPSA &&
                shouldSendNewTcToken(existingTokenEntry?.senderTimestamp) &&
                !inFlightTcTokenIssuance.has(tcTokenJid)) {
                inFlightTcTokenIssuance.add(tcTokenJid);
                const issueTimestamp = unixTimestampSeconds();
                const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
                resolveIssuanceJid(destinationJid, sock.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID)
                    .then(issueJid => issuePrivacyTokens([issueJid], issueTimestamp))
                    .then(async (result) => {
                    await storeTcTokensFromIqResult({
                        result,
                        fallbackJid: tcTokenJid,
                        keys: authState.keys,
                        getLIDForPN
                    });
                    const currentData = await authState.keys.get('tctoken', [tcTokenJid]);
                    const currentEntry = currentData[tcTokenJid];
                    const indexWrite = await buildMergedTcTokenIndexWrite(authState.keys, [tcTokenJid]);
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
        const normalizedMessage = normalizeMessageContent(message);
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
            throw new Boom('A valid proto.IMessage is required', { statusCode: 400 });
        }
        if (mode !== 'include' && mode !== 'exclude') {
            throw new Boom(`Invalid private relay mode: ${String(mode)}`, { statusCode: 400 });
        }
        if (!['all', 'primary', 'secondary'].includes(deviceMode)) {
            throw new Boom(`Invalid deviceMode: ${String(deviceMode)}`, { statusCode: 400 });
        }
        const meId = assertMeId(authState.creds);
        const meLid = authState.creds.me?.lid;
        const decodedDestination = jidDecode(jid);
        if (!decodedDestination?.user || !decodedDestination.server) {
            throw new Boom(`Invalid destination JID: ${jid}`, { statusCode: 400 });
        }
        const { user, server } = decodedDestination;
        const isNewsletter = server === 'newsletter';
        const isGroup = server === 'g.us';
        const statusJid = 'status@broadcast';
        const isStatus = jid === statusJid;
        const isGroupOrStatus = isGroup || isStatus;
        const destinationJid = isStatus ? statusJid : jid;
        const msgId = providedMessageId || generateMessageIDV2(meId);
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
        const normalizedMessage = normalizeMessageContent(message) || message;
        const interactive = normalizedMessage.interactiveMessage;
        const nativeFlowButtons = interactive?.nativeFlowMessage?.buttons || [];
        const legacyNativeFlowButtons = normalizedMessage.buttonsMessage?.buttons || [];
        const nativeFlowNames = [
            ...nativeFlowButtons.map(button => button.name),
            ...legacyNativeFlowButtons.map(button => button.nativeFlowInfo?.name)
        ].filter((name) => !!name);
        const automaticNodes = [];
        const isDirectMessage = isJidGroup(jid) || isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid);
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
            const decodedTarget = jidDecode(normalizedTarget);
            if (!decodedTarget?.user || !decodedTarget.server)
                continue;
            const hasExplicitDevice = normalizedTarget.includes(':');
            const targetDevice = hasExplicitDevice ? decodedTarget.device ?? 0 : null;
            targetRules.push({ user: decodedTarget.user, server: decodedTarget.server, device: targetDevice });
            try {
                if (decodedTarget.server === 's.whatsapp.net') {
                    const lidJid = await signalRepository.lidMapping.getLIDForPN(normalizedTarget);
                    const lidDecoded = lidJid ? jidDecode(lidJid) : undefined;
                    if (lidDecoded?.user && lidDecoded.server) {
                        targetRules.push({ user: lidDecoded.user, server: lidDecoded.server, device: targetDevice });
                    }
                }
                else if (decodedTarget.server === 'lid') {
                    const pnJid = await signalRepository.lidMapping.getPNForLID(normalizedTarget);
                    const pnDecoded = pnJid ? jidDecode(pnJid) : undefined;
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
            const decoded = jidDecode(targetJid);
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
                const decodedTarget = jidDecode(normalizedTarget);
                if (!decodedTarget?.user || !decodedTarget.server)
                    continue;
                const targetDevice = normalizedTarget.includes(':') ? decodedTarget.device ?? 0 : null;
                try {
                    const alias = decodedTarget.server === 's.whatsapp.net'
                        ? await signalRepository.lidMapping.getLIDForPN(normalizedTarget)
                        : decodedTarget.server === 'lid'
                            ? await signalRepository.lidMapping.getPNForLID(normalizedTarget)
                            : undefined;
                    const aliasDecoded = alias ? jidDecode(alias) : undefined;
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
            const decoded = jidDecode(device.jid);
            if (!decoded?.user)
                return false;
            const matches = isTargetMatch(device.jid);
            let include = mode === 'include' ? matches : !matches;
            const mePnUser = jidDecode(meId)?.user;
            const meLidUser = meLid ? jidDecode(meLid)?.user : undefined;
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
                const bytes = encodeNewsletterMessage(patched);
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
                        throw new Boom('statusJidList is required for status@broadcast private relay', { statusCode: 400 });
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
                            const decodedAlias = jidDecode(alias);
                            return decodedAlias?.user === rule.user && decodedAlias.server === rule.server;
                        }));
                        for (const rule of matchingRules) {
                            for (const alias of aliases) {
                                const decodedAlias = jidDecode(alias);
                                if (decodedAlias?.user && decodedAlias.server) {
                                    targetRules.push({ user: decodedAlias.user, server: decodedAlias.server, device: rule.device });
                                }
                            }
                        }
                    }
                }
                const senderKeyRecipients = [...new Set(devices
                        .filter(device => shouldSendToDevice(device) &&
                        !isHostedLidUser(device.jid) &&
                        !isHostedPnUser(device.jid) &&
                        device.device !== 99)
                        .map(device => device.jid))];
                if (!senderKeyRecipients.length) {
                    throw new Boom('Private relay selected zero eligible group devices. Check mode, target and deviceMode.', { statusCode: 400 });
                }
                const patched = await patchMessageBeforeSending(message);
                if (Array.isArray(patched)) {
                    throw new Boom('Per-jid patching is not supported in groups', { statusCode: 400 });
                }
                reportingMessage = patched;
                const bytes = encodeWAMessage(patched);
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
                const ownUser = jidDecode(ownId)?.user;
                const targetServer = isLid ? 'lid' : 's.whatsapp.net';
                devices.push({ user, device: 0, jid: jidEncode(user, targetServer, 0) });
                if (user !== ownUser) {
                    const ownUserForAddressing = isLid && meLid ? jidDecode(meLid).user : jidDecode(meId).user;
                    devices.push({ user: ownUserForAddressing, device: 0, jid: jidEncode(ownUserForAddressing, targetServer, 0) });
                }
                if (additionalAttributes?.['category'] !== 'peer') {
                    devices.length = 0;
                    const senderIdentity = isLid && meLid
                        ? jidEncode(jidDecode(meLid).user, 'lid', undefined)
                        : jidEncode(jidDecode(meId).user, 's.whatsapp.net', undefined);
                    devices.push(...(await getUSyncDevices([senderIdentity, jid], useCache, false)));
                }
                await refreshTargetMappingRules();
                const mePnUser = jidDecode(meId)?.user;
                const meLidUser = meLid ? jidDecode(meLid)?.user : undefined;
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
                    throw new Boom('Private relay selected zero eligible devices. Check mode, target and deviceMode.', { statusCode: 400 });
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
                    extraAttrs['phash'] = generateParticipantHashV2(allRecipients);
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
                stanza.content.push({ tag: 'device-identity', attrs: {}, content: encodeSignedDeviceIdentity(authState.creds.account, true) });
            }
            if (!isStatus && reportingMessage?.messageContextInfo?.messageSecret &&
                shouldIncludeReportingToken(reportingMessage) &&
                !(additionalNodes || []).some(node => node.tag === 'reporting')) {
                try {
                    const reportingNode = await getMessageReportingToken(encodeWAMessage(reportingMessage), reportingMessage, {
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
                const tcTokenJid = await resolveTcTokenJid(destinationJid, getLIDForPN);
                const tokenData = await authState.keys.get('tctoken', [tcTokenJid]);
                const tokenEntry = tokenData[tcTokenJid];
                if (tokenEntry?.token?.length && !isTcTokenExpired(tokenEntry.timestamp)) {
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
        const t = (timestamp ?? unixTimestampSeconds()).toString();
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
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
                            jid: jidNormalizedUser(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        });
        return result;
    };
    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn);
    const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update');
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
            const content = assertMediaContent(message.message);
            const mediaKey = content.mediaKey;
            const meId = authState.creds.me.id;
            const node = encryptMediaRetryRequest(message.key, mediaKey, meId);
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
                                const media = decryptMediaRetryData(result.media, mediaKey, result.key.id);
                                if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = proto.MediaRetryNotification.ResultType[media.result];
                                    throw new Boom(`Media re-upload failed by device (${resultStr})`, {
                                        data: media,
                                        statusCode: getStatusCodeForMediaRetry(media.result) || 404
                                    });
                                }
                                content.directPath = media.directPath;
                                content.url = getUrlFromDirectPath(content.directPath, mediaHost);
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
                isJidGroup(jid)) {
                const { disappearingMessagesInChat } = content;
                const value = typeof disappearingMessagesInChat === 'boolean'
                    ? disappearingMessagesInChat
                        ? WA_DEFAULT_EPHEMERAL
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
                    const messageSecret = photoPoll.messageSecret ? Buffer.from(photoPoll.messageSecret) : randomBytes(32);
                    if (messageSecret.length !== 32)
                        throw new Error('photoPoll.messageSecret harus 32 byte');
                    const hashOption = (name, fileSha256) => createHash('sha256')
                        .update(createHash('sha256').update(String(name)).digest('hex') + Buffer.from(fileSha256).toString('base64'))
                        .digest('hex');
                    const images = await Promise.all(photoPoll.values.map(async (item, index) => {
                        if (!item?.name || !item.image)
                            throw new Error(`photoPoll.values[${index}] harus memiliki name dan image`);
                        const { imageMessage } = await prepareWAMessageMedia({ image: item.image }, {
                            upload: waUploadToServer,
                            logger,
                            mediaCache: config.mediaCache,
                            options: config.options
                        });
                        if (!imageMessage?.fileSha256)
                            throw new Error(`Upload gambar photo poll gagal pada index ${index}`);
                        return { name: String(item.name), imageMessage, optionHash: hashOption(item.name, imageMessage.fileSha256) };
                    }));
                    const parent = generateWAMessageFromContent(jid, {
                        pollCreationMessageV3: {
                            name: photoPoll.name,
                            selectableOptionsCount: selectableCount,
                            options: images.map(({ name, optionHash }) => ({ optionName: name, optionHash })),
                            pollContentType: proto.Message.PollContentType.IMAGE
                        },
                        messageContextInfo: { messageSecret }
                    }, {
                        logger,
                        userJid,
                        messageId: options.messageId || generateMessageIDV2(sock.user?.id),
                        ...options
                    });
                    const parentKey = parent.key;
                    await relayMessage(jid, parent.message, {
                        messageId: parentKey.id,
                        useCachedGroupMetadata: options.useCachedGroupMetadata,
                        additionalNodes: [...(options.additionalNodes || []), { tag: 'meta', attrs: { polltype: 'creation', contenttype: 'image' } }]
                    });
                    for (const { imageMessage } of images) {
                        const child = proto.Message.create({
                            messageContextInfo: { messageAssociation: {
                                    parentMessageKey: parentKey,
                                    associationType: proto.MessageAssociation.AssociationType.MEDIA_POLL
                                } },
                            pollCreationOptionImageMessage: { message: { imageMessage } }
                        });
                        await relayMessage(jid, child, {
                            messageId: randomUUID(),
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
                    const rawMessage = proto.Message.fromObject({
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
                    getUrlInfo: text => getUrlInfo(text, {
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
                    messageId: generateMessageIDV2(sock.user?.id),
                    ...options
                };
                const fullMsg = buttonLocationMessage
                    ? generateWAMessageFromContent(jid, buttonLocationMessage, generationOptions)
                    : await generateWAMessage(jid, messageContent, generationOptions);
                const isEventMsg = 'event' in content && !!content.event;
                const isDeleteMsg = 'delete' in content && !!content.delete;
                const isEditMsg = 'edit' in content && !!content.edit;
                const isPinMsg = 'pin' in content && !!content.pin;
                const isPollMessage = 'poll' in content && !!content.poll;
                const isAiMsg = 'ai' in content && !!content.ai;
                const additionalAttributes = {};
                const additionalNodes = [...(options.additionalNodes || [])];
                const outgoingContent = normalizeMessageContent(fullMsg.message) || fullMsg.message;
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
                    if (isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe) {
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
                    const editedMsg = await generateWAMessage(jid, { richMessage: editedRichContent }, generationOptions);
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
                    }, { messageId: randomUUID() });
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
