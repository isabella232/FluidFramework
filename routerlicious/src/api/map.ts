import * as assert from "assert";
import * as _ from "lodash";
import * as api from ".";
import { DeltaManager } from "./deltaManager";

/**
 * Description of a map delta operation
 */
interface IMapOperation {
    type: string;
    key?: string;
    value?: IMapValue;
}

/**
 * Map snapshot definition
 */
export interface ISnapshot {
    sequenceNumber: number;
    snapshot: any;
};

export enum ValueType {
    // The value is a collaborative object
    Collaborative,

    // The value is a plain JavaScript object
    Plain,
}

export interface ICollaborativeMapValue {
    // The type of collaborative object
    type: string;

    // The id for the collaborative object
    id: string;
}

export interface IMapValue {
    // The type of the value
    type: string;

    // The actual value
    value: any;
}

/**
 * Implementation of a map collaborative object
 */
class Map extends api.CollaborativeObject implements api.IMap {
    public type = MapExtension.Type;

    private loadingP: Promise<void>;

    // Map data
    private data: {[key: string]: IMapValue } = {};

    // The last sequence number processed
    private connection: api.IDeltaConnection;
    private deltaManager: DeltaManager = null;

    // Locally applied operations not yet sent to the server
    private localOps: api.IMessage[] = [];

    // The last sequence number and offset retrieved from the server
    private sequenceNumber = 0;
    private minimumSequenceNumber = 0;

    // Sequence number for operations local to this client
    private clientSequenceNumber = 0;

    // Map of collaborative objects stored inside of the map
    private collaborativeObjects: {[id: string]: api.ICollaborativeObject} = {};

    /**
     * Constructs a new collaborative map. If the object is non-local an id and service interfaces will
     * be provided
     */
    constructor(public id: string, private services?: api.ICollaborationServices, private registry?: api.Registry) {
        super();
        this.loadingP = services ? this.load(id, services) : Promise.resolve();
    }

    public async keys(): Promise<string[]> {
        await this.loadingP;
        return _.keys(this.data);
    }

    /**
     * Retrieves the value with the given key from the map.
     */
    public async get(key: string) {
        await this.loadingP;

        if (!(key in this.data)) {
            return undefined;
        }

        const value = this.data[key];
        if (value.type === ValueType[ValueType.Collaborative]) {
            const collabMapValue = value.value as ICollaborativeMapValue;
            if (!(collabMapValue.id in this.collaborativeObjects)) {
                const extension = this.registry.getExtension(collabMapValue.type);
                this.collaborativeObjects[collabMapValue.id] =
                    extension.load(collabMapValue.id, this.services, this.registry);
            }

            return this.collaborativeObjects[collabMapValue.id];
        } else {
            return this.data[key].value;
        }
    }

    public async has(key: string): Promise<boolean> {
        await this.loadingP;
        return key in this.data;
    }

    public async set(key: string, value: any): Promise<void> {
        await this.loadingP;

        let operationValue: IMapValue;
        if (_.hasIn(value, "__collaborativeObject__")) {
            // Convert any local collaborative objects to our internal storage format
            const collaborativeObject = value as api.ICollaborativeObject;
            this.collaborativeObjects[collaborativeObject.id] = collaborativeObject;

            const collabMapValue: ICollaborativeMapValue = {
                id: collaborativeObject.id,
                type: collaborativeObject.type,
            };

            operationValue = {
                type: ValueType[ValueType.Collaborative],
                value: collabMapValue,
            };
        } else {
            operationValue = {
                type: ValueType[ValueType.Plain],
                value,
            };
        }

        const op: IMapOperation = {
            key,
            type: "set",
            value: operationValue,
        };

        return this.processLocalOperation(op);
    }

    public async delete(key: string): Promise<void> {
        await this.loadingP;
        const op: IMapOperation = {
            key,
            type: "delete",
        };

        return this.processLocalOperation(op);
    }

    public async clear(): Promise<void> {
        await this.loadingP;
        const op: IMapOperation = {
            type: "clear",
        };

        return this.processLocalOperation(op);
    }

    public snapshot(): Promise<void> {
        const snapshot = {
            sequenceNumber: this.sequenceNumber,
            snapshot: _.clone(this.data),
        };

        return this.services.objectStorageService.write(this.id, snapshot);
    }

    /**
     * Attaches the document to the given backend service.
     */
    public async attach(services: api.ICollaborationServices, registry: api.Registry): Promise<void> {
        this.services = services;
        this.registry = registry;

        // Attaching makes a local document available for collaboration. The connect call should create the object.
        // We assert the return type to validate this is the case.
        this.connection = await services.deltaNotificationService.connect(this.id, this.type);
        assert.ok(!this.connection.existing);

        // Listen for updates to create the delta manager
        this.listenForUpdates();

        // And then submit all pending operations
        for (const localOp of this.localOps) {
            this.submit(localOp);
        }
    }

    /**
     * Returns true if the object is local only
     */
    public isLocal(): boolean {
        return !this.connection;
    }

    /**
     * Loads the map from an existing storage service
     */
    private async load(id: string, services: api.ICollaborationServices): Promise<void> {
        // Load the snapshot and begin listening for messages
        this.connection = await services.deltaNotificationService.connect(id, this.type);

        // Load from the snapshot if it exists
        const rawSnapshot = this.connection.existing ? await services.objectStorageService.read(id) : null;
        const snapshot: ISnapshot = rawSnapshot
            ? JSON.parse(rawSnapshot)
            : { sequenceNumber: 0, snapshot: {} };

        this.data = snapshot.snapshot;
        this.sequenceNumber = snapshot.sequenceNumber;

        this.listenForUpdates();
    }

    private listenForUpdates() {
        this.deltaManager = new DeltaManager(
            this.sequenceNumber,
            this.services.deltaStorageService,
            this.connection,
            {
                getReferenceSequenceNumber: () => {
                    return this.sequenceNumber;
                },
                op: (message) => {
                    this.processRemoteMessage(message);
                },
            });
    }

    private async submit(message: api.IMessage): Promise<void> {
        // TODO chain these requests given the attach is async
        const op = message.op as IMapOperation;

        // We need to translate any local collaborative object sets to the serialized form
        if (op.type === "set" && op.value.type === ValueType[ValueType.Collaborative]) {
            // We need to attach the object prior to submitting the message
            const collabMapValue = op.value.value as ICollaborativeMapValue;
            const collabObject = this.collaborativeObjects[collabMapValue.id];

            if (collabObject.isLocal()) {
                await collabObject.attach(this.services, this.registry);
            }
        }

        this.deltaManager.submitOp(message);
    }

    /**
     * Processes a message by the local client
     */
    private async processLocalOperation(op: IMapOperation): Promise<void> {
        // Prep the message
        const message: api.IMessage = {
            clientSequenceNumber: this.clientSequenceNumber++,
            op,
            referenceSequenceNumber: this.sequenceNumber,
        };

        // Store the message for when it is ACKed and then submit to the server if connected
        this.localOps.push(message);
        if (this.connection) {
            this.submit(message);
        }

        this.processOperation(op);
    }

    /**
     * Handles a message coming from the remote service
     */
    private processRemoteMessage(message: api.IBase) {
        // server messages should only be delivered to this method in sequence number order
        assert.equal(this.sequenceNumber + 1, message.sequenceNumber);
        this.sequenceNumber = message.sequenceNumber;
        this.minimumSequenceNumber = message.minimumSequenceNumber;

        if (message.type === api.OperationType) {
            this.processRemoteOperation(message as api.ISequencedMessage);
        }
    }

    private processRemoteOperation(message: api.ISequencedMessage) {
        if (message.clientId === this.connection.clientId) {
            // One of our messages was sequenced. We can remove it from the local message list. Given these arrive
            // in order we only need to check the beginning of the local list.
            if (this.localOps.length > 0 &&
                this.localOps[0].clientSequenceNumber === message.clientSequenceNumber) {
                this.localOps.shift();
            } else {
                console.log(`Duplicate ack received ${message.clientSequenceNumber}`);
            }
        } else {
            // Message has come from someone else - let's go and update now
            this.processOperation(message.op);
        }
    }

    private processOperation(op: IMapOperation) {
        switch (op.type) {
            case "clear":
                this.clearCore();
                break;
            case "delete":
                this.deleteCore(op.key);
                break;
            case "set":
                this.setCore(op.key, op.value);
                break;
            default:
                throw new Error("Unknown operation");
        }
    }

    private setCore(key: string, value: IMapValue) {
        this.data[key] = value;
        this.events.emit("valueChanged", { key });
    }

    private clearCore() {
        this.data = {};
        this.events.emit("clear");
    }

    private deleteCore(key: string) {
        delete this.data[key];
        this.events.emit("valueChanged", { key });
    }
}

/**
 * The extension that defines the map
 */
export class MapExtension implements api.IExtension {
    public static Type = "https://graph.microsoft.com/types/map";

    public type: string = MapExtension.Type;

    public load(id: string, services: api.ICollaborationServices, registry: api.Registry): api.IMap {
        return new Map(id, services, registry);
    }

    public create(id: string): api.IMap {
        return new Map(id);
    }
}
