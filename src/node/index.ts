export * from './posix-env.js';
export * from './terminal-manager.js';
export { signalProcessGroup } from './process-group.js';
import { PosixNodeExecutionEnv, type NodeEnvOptions } from './posix-env.js';
import {
  createFourTools,
  type FourToolsOptions,
  type FourTool,
} from '../index.js';
export type NodeFourToolsOptions = NodeEnvOptions & FourToolsOptions;
export function createNodeEnv(
  options: NodeEnvOptions = {},
): PosixNodeExecutionEnv {
  return new PosixNodeExecutionEnv(options);
}
export function createNodeFourTools(options: NodeFourToolsOptions = {}): {
  env: PosixNodeExecutionEnv;
  tools: FourTool[];
} {
  const env = createNodeEnv(options);
  return { env, tools: createFourTools(env, options) };
}
export type NodeTools = FourTool[] & {
  env: PosixNodeExecutionEnv;
  dispose(): Promise<void>;
};
export function createNodeTools(options: NodeFourToolsOptions = {}): NodeTools {
  const { env, tools } = createNodeFourTools(options);
  return Object.assign(tools, { env, dispose: () => env.dispose() });
}
