/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../base/common/map.js';
import { equals } from '../../../base/common/objects.js';
import { URI } from '../../../base/common/uri.js';
import { ConfigurationTarget } from '../../configuration/common/configuration.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { IFileService } from '../../files/common/files.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IUriIdentityService } from '../../uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService } from '../../userDataProfile/common/userDataProfile.js';
import { DidUninstallMcpServerEvent, IGalleryMcpServer, ILocalMcpServer, IMcpGalleryService, IMcpManagementService, IMcpServerInput, IMcpServerManifest, InstallMcpServerEvent, InstallMcpServerResult, PackageType, UninstallMcpServerEvent, IScannedMcpServer, InstallOptions, UninstallOptions, IInstallableMcpServer } from './mcpManagement.js';
import { IMcpServerVariable, McpServerVariableType, IMcpServerConfiguration } from './mcpPlatformTypes.js';
import { IMcpResourceScannerService, McpResourceTarget } from './mcpResourceScannerService.js';

export interface ILocalMcpServerInfo {
	name: string;
	version: string;
	id?: string;
	displayName?: string;
	url?: string;
	description?: string;
	repositoryUrl?: string;
	publisher?: string;
	publisherDisplayName?: string;
	icon?: {
		dark: string;
		light: string;
	};
	codicon?: string;
	manifest?: IMcpServerManifest;
	readmeUrl?: URI;
	location?: URI;
}

export abstract class AbstractMcpResourceManagementService extends Disposable implements IMcpManagementService {

	_serviceBrand: undefined;

	private initializePromise: Promise<void> | undefined;
	private readonly reloadConfigurationScheduler: RunOnceScheduler;
	private local = new Map<string, ILocalMcpServer>();

	protected readonly _onInstallMcpServer = this._register(new Emitter<InstallMcpServerEvent>());
	readonly onInstallMcpServer = this._onInstallMcpServer.event;

	protected readonly _onDidInstallMcpServers = this._register(new Emitter<InstallMcpServerResult[]>());
	get onDidInstallMcpServers() { return this._onDidInstallMcpServers.event; }

	protected readonly _onDidUpdateMcpServers = this._register(new Emitter<InstallMcpServerResult[]>());
	get onDidUpdateMcpServers() { return this._onDidUpdateMcpServers.event; }

	protected readonly _onUninstallMcpServer = this._register(new Emitter<UninstallMcpServerEvent>());
	get onUninstallMcpServer() { return this._onUninstallMcpServer.event; }

	protected _onDidUninstallMcpServer = this._register(new Emitter<DidUninstallMcpServerEvent>());
	get onDidUninstallMcpServer() { return this._onDidUninstallMcpServer.event; }

	constructor(
		protected readonly mcpResource: URI,
		protected readonly target: McpResourceTarget,
		@IMcpGalleryService protected readonly mcpGalleryService: IMcpGalleryService,
		@IFileService protected readonly fileService: IFileService,
		@IUriIdentityService protected readonly uriIdentityService: IUriIdentityService,
		@ILogService protected readonly logService: ILogService,
		@IMcpResourceScannerService protected readonly mcpResourceScannerService: IMcpResourceScannerService,
	) {
		super();
		this.reloadConfigurationScheduler = this._register(new RunOnceScheduler(() => this.updateLocal(), 50));
	}

	private initialize(): Promise<void> {
		if (!this.initializePromise) {
			this.initializePromise = (async () => {
				this.local = await this.populateLocalServer();
				this.startWatching();
			})();
		}
		return this.initializePromise;
	}

	private async populateLocalServer(): Promise<Map<string, ILocalMcpServer>> {
		const local = new Map<string, ILocalMcpServer>();
		this.logService.info('MCP Management Service: fetchInstalled', this.mcpResource.toString());
		try {
			const scannedMcpServers = await this.mcpResourceScannerService.scanMcpServers(this.mcpResource, this.target);
			if (scannedMcpServers.servers) {
				await Promise.allSettled(Object.entries(scannedMcpServers.servers).map(async ([name, scannedServer]) => {
					const server = await this.scanServer(scannedServer);
					local.set(name, server);
				}));
			}
		} catch (error) {
			this.logService.debug('Could not read user MCP servers:', error);
			throw error;
		}
		return local;
	}

	private startWatching(): void {
		this._register(this.fileService.watch(this.mcpResource));
		this._register(this.fileService.onDidFilesChange(e => {
			if (e.affects(this.mcpResource)) {
				this.reloadConfigurationScheduler.schedule();
			}
		}));
	}

	private async updateLocal(): Promise<void> {
		try {
			const current = await this.populateLocalServer();

			const added: ILocalMcpServer[] = [];
			const updated: ILocalMcpServer[] = [];
			const removed = [...this.local.keys()].filter(name => !current.has(name));

			for (const server of removed) {
				this.local.delete(server);
			}

			for (const [name, server] of current) {
				const previous = this.local.get(name);
				if (previous) {
					if (!equals(previous, server)) {
						updated.push(server);
						this.local.set(name, server);
					}
				} else {
					added.push(server);
					this.local.set(name, server);
				}
			}

			for (const server of removed) {
				this.local.delete(server);
				this._onDidUninstallMcpServer.fire({ name: server, mcpResource: this.mcpResource });
			}

			if (updated.length) {
				this._onDidUpdateMcpServers.fire(updated.map(server => ({ name: server.name, local: server, mcpResource: this.mcpResource })));
			}

			if (added.length) {
				this._onDidInstallMcpServers.fire(added.map(server => ({ name: server.name, local: server, mcpResource: this.mcpResource })));
			}

		} catch (error) {
			this.logService.error('Failed to load installed MCP servers:', error);
		}
	}

	async getInstalled(): Promise<ILocalMcpServer[]> {
		await this.initialize();
		return Array.from(this.local.values());
	}

	protected async scanServer(scannedMcpServer: IScannedMcpServer): Promise<ILocalMcpServer> {
		let mcpServerInfo = await this.getLocalMcpServerInfo(scannedMcpServer);
		if (!mcpServerInfo) {
			mcpServerInfo = {
				name: scannedMcpServer.name,
				version: '1.0.0',
			};
		}

		return {
			name: scannedMcpServer.name,
			config: scannedMcpServer.config,
			version: mcpServerInfo.version,
			mcpResource: this.mcpResource,
			location: mcpServerInfo.location,
			id: mcpServerInfo.id,
			displayName: mcpServerInfo.displayName,
			description: mcpServerInfo.description,
			publisher: mcpServerInfo.publisher,
			publisherDisplayName: mcpServerInfo.publisherDisplayName,
			repositoryUrl: mcpServerInfo.repositoryUrl,
			readmeUrl: mcpServerInfo.readmeUrl,
			icon: mcpServerInfo.icon,
			codicon: mcpServerInfo.codicon,
			manifest: mcpServerInfo.manifest
		};
	}

	async install(server: IInstallableMcpServer, options?: Omit<InstallOptions, 'mcpResource'>): Promise<ILocalMcpServer> {
		this.logService.trace('MCP Management Service: install', server.name);

		this._onInstallMcpServer.fire({ name: server.name, mcpResource: this.mcpResource });
		try {
			const scannedServer: IScannedMcpServer = {
				id: server.name,
				name: server.name,
				version: '0.0.1',
				config: server.config
			};

			await this.mcpResourceScannerService.addMcpServers([{ server: scannedServer, inputs: server.inputs }], this.mcpResource, this.target);

			const local = await this.scanServer(scannedServer);
			this.reloadConfigurationScheduler.schedule();
			return local;
		} catch (e) {
			this._onDidInstallMcpServers.fire([{ name: server.name, error: e, mcpResource: this.mcpResource }]);
			throw e;
		}
	}

	async uninstall(server: ILocalMcpServer, options?: Omit<UninstallOptions, 'mcpResource'>): Promise<void> {
		this.logService.trace('MCP Management Service: uninstall', server.name);
		this._onUninstallMcpServer.fire({ name: server.name, mcpResource: this.mcpResource });

		try {
			const currentServers = await this.mcpResourceScannerService.scanMcpServers(this.mcpResource, this.target);
			if (!currentServers.servers) {
				return;
			}
			await this.mcpResourceScannerService.removeMcpServers([server.name], this.mcpResource, this.target);
			if (server.location) {
				await this.fileService.del(URI.revive(server.location), { recursive: true });
			}
			this.reloadConfigurationScheduler.schedule();
		} catch (e) {
			this._onDidUninstallMcpServer.fire({ name: server.name, error: e, mcpResource: this.mcpResource });
			throw e;
		}
	}

	protected toScannedMcpServerAndInputs(manifest: IMcpServerManifest, packageType?: PackageType): { config: IMcpServerConfiguration; inputs?: IMcpServerVariable[] } {
		if (packageType === undefined) {
			packageType = manifest.packages?.[0]?.registry_name ?? PackageType.REMOTE;
		}

		let config: IMcpServerConfiguration;
		const inputs: IMcpServerVariable[] = [];

		if (packageType === PackageType.REMOTE && manifest.remotes?.length) {
			const headers: Record<string, string> = {};
			for (const input of manifest.remotes[0].headers ?? []) {
				const variables = input.variables ? this.getVariables(input.variables) : [];
				let value = input.value;
				for (const variable of variables) {
					value = value.replace(`{${variable.id}}`, `{input:${variable.id}}`);
				}
				headers[input.name] = value;
				if (variables.length) {
					inputs.push(...variables);
				}
			}
			config = {
				type: 'http',
				url: manifest.remotes[0].url,
				headers: Object.keys(headers).length ? headers : undefined,
			};
		} else {
			const serverPackage = manifest.packages?.find(p => p.registry_name === packageType) ?? manifest.packages?.[0];
			if (!serverPackage) {
				throw new Error(`No server package found`);
			}

			const args: string[] = [];
			const env: Record<string, string> = {};

			if (serverPackage.registry_name === PackageType.DOCKER) {
				args.push('run');
				args.push('-i');
				args.push('--rm');
			}

			for (const arg of serverPackage.runtime_arguments ?? []) {
				const variables = arg.variables ? this.getVariables(arg.variables) : [];
				if (arg.type === 'positional') {
					let value = arg.value;
					if (value) {
						for (const variable of variables) {
							value = value.replace(`{${variable.id}}`, `{input:${variable.id}}`);
						}
					}
					args.push(value ?? arg.value_hint);
				} else if (arg.type === 'named') {
					args.push(arg.name);
					if (arg.value) {
						let value = arg.value;
						for (const variable of variables) {
							value = value.replace(`{${variable.id}}`, `{input:${variable.id}}`);
						}
						args.push(value);
					}
				}
				if (variables.length) {
					inputs.push(...variables);
				}
			}

			for (const input of serverPackage.environment_variables ?? []) {
				const variables = input.variables ? this.getVariables(input.variables) : [];
				let value = input.value;
				for (const variable of variables) {
					value = value.replace(`{${variable.id}}`, `{input:${variable.id}}`);
				}
				env[input.name] = value;
				if (variables.length) {
					inputs.push(...variables);
				}
				if (serverPackage.registry_name === PackageType.DOCKER) {
					args.push('-e');
					args.push(input.name);
				}
			}

			if (serverPackage.registry_name === PackageType.NODE) {
				args.push(serverPackage.version ? `${serverPackage.name}@${serverPackage.version}` : serverPackage.name);
			}
			else if (serverPackage.registry_name === PackageType.PYTHON) {
				args.push(serverPackage.version ? `${serverPackage.name}==${serverPackage.version}` : serverPackage.name);
			}
			else if (serverPackage.registry_name === PackageType.DOCKER) {
				args.push(serverPackage.version ? `${serverPackage.name}:${serverPackage.version}` : serverPackage.name);
			}

			for (const arg of serverPackage.package_arguments ?? []) {
				const variables = arg.variables ? this.getVariables(arg.variables) : [];
				if (arg.type === 'positional') {
					let value = arg.value;
					if (value) {
						for (const variable of variables) {
							value = value.replace(`{${variable.id}}`, `{input:${variable.id}}`);
						}
					}
					args.push(value ?? arg.value_hint);
				} else if (arg.type === 'named') {
					args.push(arg.name);
					if (arg.value) {
						let value = arg.value;
						for (const variable of variables) {
							value = value.replace(`{${variable.id}}`, `{input:${variable.id}}`);
						}
						args.push(value);
					}
				}
				if (variables.length) {
					inputs.push(...variables);
				}
			}

			config = {
				type: 'stdio',
				command: this.getCommandName(serverPackage.registry_name),
				args: args.length ? args : undefined,
				env: Object.keys(env).length ? env : undefined,
			};
		}

		return {
			config,
			inputs: inputs.length ? inputs : undefined,
		};
	}

	private getCommandName(packageType: PackageType): string {
		switch (packageType) {
			case PackageType.NODE: return 'npx';
			case PackageType.DOCKER: return 'docker';
			case PackageType.PYTHON: return 'uvx';
		}
		return packageType;
	}

	private getVariables(variableInputs: Record<string, IMcpServerInput>): IMcpServerVariable[] {
		const variables: IMcpServerVariable[] = [];
		for (const [key, value] of Object.entries(variableInputs)) {
			variables.push({
				id: key,
				type: value.choices ? McpServerVariableType.PICK : McpServerVariableType.PROMPT,
				description: value.description ?? '',
				password: !!value.is_secret,
				default: value.default,
				options: value.choices,
			});
		}
		return variables;
	}

	abstract installFromGallery(server: IGalleryMcpServer, options?: InstallOptions): Promise<ILocalMcpServer>;
	protected abstract getLocalMcpServerInfo(scannedMcpServer: IScannedMcpServer): Promise<ILocalMcpServerInfo | undefined>;
}

export class McpUserResourceManagementService extends AbstractMcpResourceManagementService implements IMcpManagementService {

	private readonly mcpLocation: URI;

	constructor(
		mcpResource: URI,
		@IMcpGalleryService mcpGalleryService: IMcpGalleryService,
		@IFileService fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ILogService logService: ILogService,
		@IMcpResourceScannerService mcpResourceScannerService: IMcpResourceScannerService,
		@IEnvironmentService environmentService: IEnvironmentService
	) {
		super(mcpResource, ConfigurationTarget.USER, mcpGalleryService, fileService, uriIdentityService, logService, mcpResourceScannerService);
		this.mcpLocation = uriIdentityService.extUri.joinPath(environmentService.userRoamingDataHome, 'mcp');
	}

	async installFromGallery(server: IGalleryMcpServer, options?: InstallOptions): Promise<ILocalMcpServer> {
		this.logService.trace('MCP Management Service: installGallery', server.url);

		this._onInstallMcpServer.fire({ name: server.name, mcpResource: this.mcpResource });

		try {
			const manifest = await this.mcpGalleryService.getManifest(server, CancellationToken.None);
			const location = this.getLocation(server.name, server.version);
			const manifestPath = this.uriIdentityService.extUri.joinPath(location, 'manifest.json');
			await this.fileService.writeFile(manifestPath, VSBuffer.fromString(JSON.stringify({
				id: server.id,
				name: server.name,
				displayName: server.displayName,
				description: server.description,
				version: server.version,
				publisher: server.publisher,
				publisherDisplayName: server.publisherDisplayName,
				repository: server.repositoryUrl,
				licenseUrl: server.licenseUrl,
				icon: server.icon,
				codicon: server.codicon,
				...manifest,
			})));

			if (server.readmeUrl) {
				const readme = await this.mcpGalleryService.getReadme(server, CancellationToken.None);
				await this.fileService.writeFile(this.uriIdentityService.extUri.joinPath(location, 'README.md'), VSBuffer.fromString(readme));
			}
			const { config, inputs } = this.toScannedMcpServerAndInputs(manifest, options?.packageType);

			const scannedServer: IScannedMcpServer = {
				id: server.id,
				name: server.name,
				version: server.version,
				gallery: true,
				config
			};

			await this.mcpResourceScannerService.addMcpServers([{ server: scannedServer, inputs }], this.mcpResource, this.target);

			const local = await this.scanServer(scannedServer);
			return local;
		} catch (e) {
			this._onDidInstallMcpServers.fire([{ name: server.name, source: server, error: e, mcpResource: this.mcpResource }]);
			throw e;
		}
	}

	protected async getLocalMcpServerInfo(scannedMcpServer: IScannedMcpServer): Promise<ILocalMcpServerInfo | undefined> {
		let storedMcpServerInfo: ILocalMcpServerInfo | undefined;
		let location: URI | undefined;
		let readmeUrl: URI | undefined;
		if (scannedMcpServer.gallery) {
			location = this.getLocation(scannedMcpServer.name, scannedMcpServer.version);
			const manifestLocation = this.uriIdentityService.extUri.joinPath(location, 'manifest.json');
			try {
				const content = await this.fileService.readFile(manifestLocation);
				storedMcpServerInfo = JSON.parse(content.value.toString()) as ILocalMcpServerInfo;
				storedMcpServerInfo.location = location;
				readmeUrl = this.uriIdentityService.extUri.joinPath(location, 'README.md');
				if (!await this.fileService.exists(readmeUrl)) {
					readmeUrl = undefined;
				}
				storedMcpServerInfo.readmeUrl = readmeUrl;
			} catch (e) {
				this.logService.error('MCP Management Service: failed to read manifest', location.toString(), e);
			}
		}
		return storedMcpServerInfo;
	}

	private getLocation(name: string, version?: string): URI {
		name = name.replace('/', '.');
		return this.uriIdentityService.extUri.joinPath(this.mcpLocation, version ? `${name}-${version}` : name);
	}

}

export class McpManagementService extends Disposable implements IMcpManagementService {

	readonly _serviceBrand: undefined;

	private readonly _onInstallMcpServer = this._register(new Emitter<InstallMcpServerEvent>());
	readonly onInstallMcpServer = this._onInstallMcpServer.event;

	private readonly _onDidInstallMcpServers = this._register(new Emitter<readonly InstallMcpServerResult[]>());
	readonly onDidInstallMcpServers = this._onDidInstallMcpServers.event;

	private readonly _onDidUpdateMcpServers = this._register(new Emitter<readonly InstallMcpServerResult[]>());
	readonly onDidUpdateMcpServers = this._onDidUpdateMcpServers.event;

	private readonly _onUninstallMcpServer = this._register(new Emitter<UninstallMcpServerEvent>());
	readonly onUninstallMcpServer = this._onUninstallMcpServer.event;

	private readonly _onDidUninstallMcpServer = this._register(new Emitter<DidUninstallMcpServerEvent>());
	readonly onDidUninstallMcpServer = this._onDidUninstallMcpServer.event;

	private readonly mcpResourceManagementServices = new ResourceMap<{ service: McpUserResourceManagementService } & IDisposable>();

	constructor(
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	private getMcpResourceManagementService(mcpResource: URI): McpUserResourceManagementService {
		let mcpResourceManagementService = this.mcpResourceManagementServices.get(mcpResource);
		if (!mcpResourceManagementService) {
			const disposables = new DisposableStore();
			const service = disposables.add(this.instantiationService.createInstance(McpUserResourceManagementService, mcpResource));
			disposables.add(service.onInstallMcpServer(e => this._onInstallMcpServer.fire(e)));
			disposables.add(service.onDidInstallMcpServers(e => this._onDidInstallMcpServers.fire(e)));
			disposables.add(service.onDidUpdateMcpServers(e => this._onDidUpdateMcpServers.fire(e)));
			disposables.add(service.onUninstallMcpServer(e => this._onUninstallMcpServer.fire(e)));
			disposables.add(service.onDidUninstallMcpServer(e => this._onDidUninstallMcpServer.fire(e)));
			this.mcpResourceManagementServices.set(mcpResource, mcpResourceManagementService = { service, dispose: () => disposables.dispose() });
		}
		return mcpResourceManagementService.service;
	}

	async getInstalled(mcpResource?: URI): Promise<ILocalMcpServer[]> {
		const mcpResourceUri = mcpResource || this.userDataProfilesService.defaultProfile.mcpResource;
		return this.getMcpResourceManagementService(mcpResourceUri).getInstalled();
	}

	async install(server: IInstallableMcpServer, options?: InstallOptions): Promise<ILocalMcpServer> {
		const mcpResourceUri = options?.mcpResource || this.userDataProfilesService.defaultProfile.mcpResource;
		return this.getMcpResourceManagementService(mcpResourceUri).install(server, options);
	}

	async uninstall(server: ILocalMcpServer, options?: UninstallOptions): Promise<void> {
		const mcpResourceUri = options?.mcpResource || this.userDataProfilesService.defaultProfile.mcpResource;
		return this.getMcpResourceManagementService(mcpResourceUri).uninstall(server, options);
	}

	async installFromGallery(server: IGalleryMcpServer, options?: InstallOptions): Promise<ILocalMcpServer> {
		const mcpResourceUri = options?.mcpResource || this.userDataProfilesService.defaultProfile.mcpResource;
		return this.getMcpResourceManagementService(mcpResourceUri).installFromGallery(server, options);
	}

	override dispose(): void {
		this.mcpResourceManagementServices.forEach(service => service.dispose());
		this.mcpResourceManagementServices.clear();
		super.dispose();
	}

}
