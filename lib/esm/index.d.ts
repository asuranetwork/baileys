import makeWASocket from './Socket/index.js';
export * from '../WAProto/index.mjs';
export * from './Utils/index.js';
export * from './Types/index.js';
export * from './Defaults/index.js';
export * from './WABinary/index.js';
export * from './WAM/index.js';
export * from './WAUSync/index.js';
export type WASocket = ReturnType<typeof makeWASocket>;
export { makeWASocket };
export default makeWASocket;

export declare function makeInMemoryStore(config?: { socket?: any; logger?: any; chatKey?: any; labelAssociationKey?: any }): any;
