/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as cell from "@fluidframework/cell";
import { IRequest } from "@fluidframework/component-core-interfaces";
import { FluidDataStoreRuntime } from "@fluidframework/component-runtime";
import {
    ICodeLoader,
    IContainerContext,
    IFluidCodeDetails,
    IRuntime,
    IRuntimeFactory,
    IFluidModule,
} from "@fluidframework/container-definitions";
import { ContainerRuntime, IContainerRuntimeOptions } from "@fluidframework/container-runtime";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions";
import * as ink from "@fluidframework/ink";
import * as map from "@fluidframework/map";
import { ConsensusQueue } from "@fluidframework/ordered-collection";
import {
    IFluidDataStoreContext,
    IFluidDataStoreFactory,
    NamedFluidDataStoreRegistryEntries,
} from "@fluidframework/runtime-definitions";
import { CreateContainerError } from "@fluidframework/container-utils";
import * as sequence from "@fluidframework/sequence";
import { Document } from "./document";

const rootMapId = "root";
const insightsMapId = "insights";

export class Chaincode implements IFluidDataStoreFactory {
    public readonly type = "@fluid-internal/client-api";

    public get IFluidDataStoreFactory() { return this; }

    public constructor(private readonly closeFn: () => void) { }

    public instantiateDataStore(context: IFluidDataStoreContext): void {
        // Create channel factories
        const mapFactory = map.SharedMap.getFactory();
        const sharedStringFactory = sequence.SharedString.getFactory();
        const inkFactory = ink.Ink.getFactory();
        const cellFactory = cell.SharedCell.getFactory();
        const objectSequenceFactory = sequence.SharedObjectSequence.getFactory();
        const numberSequenceFactory = sequence.SharedNumberSequence.getFactory();
        const consensusQueueFactory = ConsensusQueue.getFactory();
        const sparseMatrixFactory = sequence.SparseMatrix.getFactory();
        const directoryFactory = map.SharedDirectory.getFactory();
        const sharedIntervalFactory = sequence.SharedIntervalCollection.getFactory();

        // Register channel factories
        const modules = new Map<string, any>();
        modules.set(mapFactory.type, mapFactory);
        modules.set(sharedStringFactory.type, sharedStringFactory);
        modules.set(inkFactory.type, inkFactory);
        modules.set(cellFactory.type, cellFactory);
        modules.set(objectSequenceFactory.type, objectSequenceFactory);
        modules.set(numberSequenceFactory.type, numberSequenceFactory);
        modules.set(consensusQueueFactory.type, consensusQueueFactory);
        modules.set(sparseMatrixFactory.type, sparseMatrixFactory);
        modules.set(directoryFactory.type, directoryFactory);
        modules.set(sharedIntervalFactory.type, sharedIntervalFactory);

        const runtime = FluidDataStoreRuntime.load(context, modules);

        // Initialize core data structures
        let root: map.ISharedMap;
        if (!runtime.existing) {
            root = map.SharedMap.create(runtime, rootMapId);
            root.bindToContext();

            const insights = map.SharedMap.create(runtime, insightsMapId);
            root.set(insightsMapId, insights.handle);
        }

        // Create the underlying Document
        const createDocument = async () => {
            root = await runtime.getChannel(rootMapId) as map.ISharedMap;
            return new Document(runtime, context, root, this.closeFn);
        };
        const documentP = createDocument();

        // And then return it from requests
        runtime.registerRequestHandler(async (request) => {
            const document = await documentP;
            return {
                mimeType: "fluid/object",
                status: 200,
                value: document,
            };
        });
    }
}

export class ChaincodeFactory implements IRuntimeFactory {
    public get IRuntimeFactory() { return this; }

    /**
     * A request handler for a container runtime
     * @param request - The request
     * @param runtime - Container Runtime instance
     */
    private static async containerRequestHandler(request: IRequest, runtime: IContainerRuntime) {
        const trimmed = request.url
            .substr(1)
            .substr(0, !request.url.includes("/", 1) ? request.url.length : request.url.indexOf("/"));

        const componentId = trimmed !== "" ? trimmed : rootMapId;

        const component = await runtime.getDataStore(componentId, true);
        return component.request({ url: trimmed.substr(1 + trimmed.length) });
    }

    constructor(
        private readonly runtimeOptions: IContainerRuntimeOptions,
        private readonly registries: NamedFluidDataStoreRegistryEntries) {
    }

    public async instantiateRuntime(context: IContainerContext): Promise<IRuntime> {
        const chaincode = new Chaincode(context.closeFn);

        const runtime = await ContainerRuntime.load(
            context,
            [
                [chaincode.type, Promise.resolve(chaincode)],
                ...this.registries,
            ],
            ChaincodeFactory.containerRequestHandler,
            this.runtimeOptions);

        // On first boot create the base component
        if (!runtime.existing) {
            runtime._createDataStore(rootMapId, "@fluid-internal/client-api")
                .then((componentRuntime) => {
                    componentRuntime.bindToContext();
                })
                .catch((error: any) => {
                    context.closeFn(CreateContainerError(error));
                });
        }

        return runtime;
    }
}

export class CodeLoader implements ICodeLoader {
    private readonly fluidModule: IFluidModule;

    constructor(
        runtimeOptions: IContainerRuntimeOptions,
        registries: NamedFluidDataStoreRegistryEntries = [],
    ) {
        this.fluidModule = {
            fluidExport: new ChaincodeFactory(
                runtimeOptions,
                registries),
        };
    }

    public async load(source: IFluidCodeDetails): Promise<IFluidModule> {
        return Promise.resolve(this.fluidModule);
    }
}
