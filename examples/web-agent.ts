import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  AnthropicClient,
  OpenAIClient,
  GeminiClient,
  type ILLMClient,
} from '@nia-teams/ai';
import {
  createAgentHost,
  createMemoryDocStore,
  createMemoryPubSub,
} from '@nia-teams/agent-core/host';
import { createSnapshotStream } from '@nia-teams/agent-core/snapshot-stream';
import { createNodeFourTools } from '@nia-teams/four-tools/node';
import {
  FileMutationQueue,
  type FourToolContext,
  type NativeToolContext,
  type FourToolResult,
} from '@nia-teams/four-tools';

export function selectWebClient(
  vars: NodeJS.ProcessEnv = process.env,
): ILLMClient {
  if (vars.ANTHROPIC_API_KEY)
    return new AnthropicClient({
      apiKey: vars.ANTHROPIC_API_KEY,
      model: vars.MODEL ?? 'claude-sonnet-4-5',
    });
  if (vars.OPENAI_API_KEY) {
    const baseURL = vars.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const deepseek = new URL(baseURL).hostname === 'api.deepseek.com';
    return new OpenAIClient({
      apiKey: vars.OPENAI_API_KEY,
      baseURL,
      model: vars.MODEL ?? (deepseek ? 'deepseek-chat' : 'gpt-4.1'),
    });
  }
  if (vars.GEMINI_API_KEY)
    return new GeminiClient({
      apiKey: vars.GEMINI_API_KEY,
      model: vars.MODEL ?? 'gemini-2.5-flash',
    });
  throw new Error(
    'Set ANTHROPIC_API_KEY, OPENAI_API_KEY (+ OPENAI_BASE_URL), or GEMINI_API_KEY.',
  );
}
export interface WebAgentOptions {
  client?: ILLMClient;
  host?: string;
  port?: number;
  workspaceDir?: string;
  token?: string;
}
export async function startWebAgent(options: WebAgentOptions = {}) {
  const upstream = options.client ?? selectWebClient();
  const requestedDirectory = options.workspaceDir ?? process.env.WORKSPACE_DIR;
  const directory = requestedDirectory
    ? resolve(requestedDirectory)
    : await fs.mkdtemp(join(tmpdir(), 'four-tools-web-'));
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.realpath(directory);
  const token = options.token ?? process.env.WEB_AGENT_TOKEN ?? randomUUID();
  if (Buffer.byteLength(token) < 16)
    throw new Error('WEB_AGENT_TOKEN must contain at least 16 bytes');
  const shutdown = new AbortController();
  const client: ILLMClient = {
    getProviderName: () => upstream.getProviderName(),
    getModelName: () => upstream.getModelName(),
    chat: (request) =>
      upstream.chat({
        ...request,
        signal: request.signal
          ? AbortSignal.any([request.signal, shutdown.signal])
          : shutdown.signal,
      }),
  };
  const sessions = new Map<string, ReturnType<typeof createNodeFourTools>>();
  const mutationQueue = new FileMutationQueue();
  const workspaceId = randomUUID();
  let closing = false;
  // AgentHost compacts turn events after persisting messages. The browser journal
  // retains the published frames for this demo process's reconnect lifetime.
  const journals = new Map<string, string[]>();
  const toolOutputs = new Map<string, Map<string, string>>();
  const pubSub = createMemoryPubSub();
  const publish = pubSub.publish.bind(pubSub);
  pubSub.publish = async (channel, payload) => {
    const journal = journals.get(channel);
    const event = journal ? JSON.parse(payload) : undefined;
    if (event?.type === 'tool_call_end') {
      const outputs = toolOutputs.get(channel);
      const content = outputs?.get(event.toolCallId);
      if (content !== undefined) {
        if (event.error) event.error = content;
        else event.output = content;
        outputs?.delete(event.toolCallId);
      }
    }
    const frame = journal
      ? JSON.stringify({ ...event, _eventId: journal.length + 1 })
      : payload;
    journal?.push(frame);
    await publish(channel, frame);
  };
  const host = createAgentHost({
    docStore: createMemoryDocStore(),
    pubSub,
    resolveAgentConfig(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Unknown session');
      return {
        client,
        tools: session.tools,
        systemPrompt:
          'You are a local coding assistant. Use read, write, edit, and shell to complete tasks in the working directory. Inspect files before editing. Ask before destructive or external actions. Long shell commands continue in managed terminals after the foreground wait. When terminal_exit arrives, inspect results and report them. Do not read credentials or files outside the requested workspace.',
      };
    },
  });
  const streams = new Set<ServerResponse>();
  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const part of req) {
      bytes += part.length;
      if (bytes > 128 * 1024) throw new Error('Request body too large');
      parts.push(Buffer.from(part));
    }
    const parsed: unknown = JSON.parse(
      Buffer.concat(parts, bytes).toString('utf8') || '{}',
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Expected an object');
    return parsed as Record<string, unknown>;
  }
  async function previewPath(input: string): Promise<string> {
    const file = await fs.realpath(resolve(root, input));
    const rel = relative(root, file);
    if (rel === '..' || rel.startsWith('..' + '/') || isAbsolute(rel))
      throw new Error('Path is outside the workspace');
    return file;
  }
  async function tree() {
    const files: Array<{ path: string; directory: boolean; symlink: boolean }> =
      [];
    async function walk(dir: string, depth: number) {
      if (depth > 6 || files.length >= 2000) return;
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (files.length >= 2000) break;
        if (['node_modules', '.git'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        files.push({
          path: relative(root, full),
          directory: entry.isDirectory(),
          symlink: entry.isSymbolicLink(),
        });
        if (entry.isDirectory()) await walk(full, depth + 1);
      }
    }
    await walk(root, 0);
    return files;
  }
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(page);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        json(res, 404, { error: 'Not found' });
        return;
      }
      const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (
        Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      ) {
        json(res, 401, {
          error: 'Open the server URL containing the access token.',
        });
        return;
      }
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      ) {
        json(res, 403, { error: 'Cross-origin requests are not allowed' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const id = randomUUID();
        const session = createNodeFourTools({
          cwd: root,
          id: workspaceId,
          mutationQueue,
          onTerminalExit: async (event) => {
            if (!closing)
              await host.injectMessage({
                sessionId: id,
                userId: 'terminal',
                userName: 'Terminal',
                eventType: 'terminal_exit',
                content: JSON.stringify(event),
              });
          },
          onTerminalError: (error) =>
            console.error(
              'Terminal error:',
              error instanceof Error ? error.message : 'unknown',
            ),
        });
        const outputs = new Map<string, string>();
        session.tools = session.tools.map((tool) => {
          function execute(
            input: Record<string, unknown>,
            ctx: NativeToolContext,
          ): Promise<string>;
          function execute(
            input: Record<string, unknown>,
            ctx?: FourToolContext,
          ): Promise<FourToolResult>;
          async function execute(
            input: Record<string, unknown>,
            ctx?: FourToolContext,
          ): Promise<FourToolResult> {
            const result = await tool.execute(input, ctx);
            if (ctx?.toolCallId)
              outputs.set(
                ctx.toolCallId,
                typeof result === 'string' ? result : result.content,
              );
            return result;
          }
          return { ...tool, execute };
        });
        sessions.set(id, session);
        journals.set(host.broadcastChannel(id), []);
        toolOutputs.set(host.broadcastChannel(id), outputs);
        json(res, 201, {
          sessionId: id,
          workspace: root,
          model: client.getModelName(),
        });
        return;
      }
      const id = url.searchParams.get('sessionId') ?? '';
      const session = sessions.get(id);
      if (!session) {
        json(res, 404, { error: 'Unknown session' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/messages') {
        const input = await body(req);
        if (typeof input.content !== 'string' || !input.content.trim())
          throw new Error('content must be a non-empty string');
        const messageId = randomUUID();
        await host.publish(
          id,
          JSON.stringify({
            type: 'user_message',
            messageId,
            content: input.content,
            userId: 'browser',
            userName: 'You',
            timestamp: Date.now(),
          }),
        );
        json(
          res,
          202,
          await host.injectMessage({
            sessionId: id,
            messageId,
            userId: 'browser',
            userName: 'You',
            content: input.content,
          }),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        const since = Number(url.searchParams.get('since') ?? 0);
        if (!Number.isSafeInteger(since) || since < 0)
          throw new Error('Invalid replay offset');
        streams.add(res);
        res.once('close', () => streams.delete(res));
        await createSnapshotStream({
          reply: res,
          format: 'sse',
          subscribeChannel: (listener) => host.subscribeBroadcast(id, listener),
          buildSnapshot: () => ({
            type: 'snapshot',
            sessionId: id,
            model: client.getModelName(),
            workspace: root,
          }),
          getCurrentSeq: () =>
            (journals.get(host.broadcastChannel(id)) ?? []).length,
          fetchBufferedEvents: (upTo) =>
            (journals.get(host.broadcastChannel(id)) ?? []).filter((raw) => {
              const seq = Number(JSON.parse(raw)._eventId);
              return seq > since && seq <= upTo;
            }),
          logger: {
            info() {},
            warn: (...args) => console.error('Stream error:', ...args),
          },
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/terminals') {
        json(res, 200, await session.env.terminals!.list());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/files') {
        if (url.searchParams.has('path')) {
          const file = await previewPath(url.searchParams.get('path')!);
          const result = await session.env.readRange(file);
          json(res, 200, { path: relative(root, file), ...result });
        } else json(res, 200, { workspace: root, files: await tree() });
        return;
      }
      json(res, 404, { error: 'Not found' });
    })().catch((error) => {
      if (res.headersSent) res.destroy();
      else
        json(res, 400, {
          error: error instanceof Error ? error.message : 'Request failed',
        });
    });
  });
  await host.start();
  const hostname = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT ?? 18880);
  try {
    await new Promise<void>((yes, no) => {
      server.once('error', no);
      server.listen(port, hostname, () => {
        server.removeListener('error', no);
        yes();
      });
    });
  } catch (error) {
    await host.stop();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No server address');
  const url = `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${address.port}`;
  return {
    server,
    host,
    url,
    token,
    workspace: root,
    async close() {
      if (closing) return;
      closing = true;
      shutdown.abort();
      for (const stream of streams) stream.destroy();
      const stopped = new Promise<void>((yes) => server.close(() => yes()));
      server.closeAllConnections();
      await Promise.all(
        [...sessions.values()].map((session) => session.env.dispose()),
      );
      await host.stop();
      await stopped;
      if ('close' in upstream && typeof upstream.close === 'function')
        await upstream.close();
    },
  };
}

const page = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>four-tools · Local agent</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#242333;background:#f6f5f9;font-size:14px}*{box-sizing:border-box}body{margin:0}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #dfdce9;background:white;color:inherit;border-radius:9px;padding:9px 12px}button:hover{border-color:#8271d8;background:#f3f0ff}button:disabled{opacity:.5;cursor:wait}svg{width:18px;height:18px;vertical-align:middle;fill:none;stroke:currentColor;stroke-width:1.7}header{height:66px;padding:0 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e4e1eb;background:#fff}header strong{font-size:18px;letter-spacing:-.6px}header small{color:#7a748b}.tag{border:1px solid #e6dffa;border-radius:30px;color:#6d53b1;font-size:11px;padding:4px 8px}.spacer{flex:1}.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;height:calc(100dvh - 66px);max-width:1600px;margin:auto}main{min-width:0;display:flex;flex-direction:column}#conversation{flex:1;overflow:auto;padding:28px max(20px,calc((100% - 820px)/2))}.intro{margin:8vh auto 30px;max-width:680px}.intro h1{font-size:34px;letter-spacing:-1.4px;line-height:1.15;margin-bottom:12px}.muted{color:#777186;line-height:1.7}.prompts{display:grid;gap:10px;margin-top:26px}.prompts button{text-align:left;padding:14px 16px;display:flex;gap:14px;align-items:center;box-shadow:0 2px 4px #2e234004}.num{font-size:12px;color:#7961be;background:#eee8fb;border-radius:6px;padding:5px 8px}.prompts b{display:block;font-weight:550}.prompts small{display:block;color:#898194;margin-top:4px}.message{margin:0 0 22px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.message.user{background:#ede8f8;padding:14px 18px;border-radius:14px 14px 3px 14px;margin-left:12%;color:#4c3e6b}.message.assistant{padding:10px 0}.label{font-size:10px;letter-spacing:1.5px;font-weight:600;color:#9689ad;margin-bottom:6px}.message.error{color:#a43248}.tool,details.reasoning{background:#fff;border:1px solid #e5e1ec;border-radius:10px;margin:10px 0;overflow:hidden}.tool summary,details.reasoning summary{cursor:pointer;padding:11px 14px;color:#675d7a;font-family:ui-monospace,monospace;font-size:12px}.tool pre,details.reasoning pre{margin:0;padding:14px;border-top:1px solid #eeeaf3;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 ui-monospace,monospace;max-height:320px;overflow:auto}.tool.done summary{color:#4c7766}.composer{padding:16px 24px 20px;border-top:1px solid #e9e5ef;background:#faf9fc}.compose-row{max-width:820px;margin:auto;display:flex;gap:10px}textarea{resize:none;min-width:0;flex:1;border:1px solid #dcd7e7;border-radius:12px;padding:12px;background:#fff;outline-color:#8d77cb;line-height:1.5}.send{background:#7553bd;color:#fff;border:0;align-self:flex-end;height:45px;width:45px}.send:hover{background:#6242a6;color:#fff}.footnote{text-align:center;color:#9a92a6;font-size:10px;margin-top:9px}aside{border-left:1px solid #e4e0ec;background:#fdfcfe;overflow:auto;padding:22px 18px}aside h2{font-size:11px;text-transform:uppercase;letter-spacing:1.7px;color:#83758f;margin:4px 0 16px}.workspace-path{font:11px/1.5 ui-monospace,monospace;overflow-wrap:anywhere;color:#a096ae;margin-bottom:18px}#files{display:grid;gap:3px}#files button{text-align:left;border:0;border-radius:6px;padding:8px;font:12px ui-monospace,monospace;overflow-wrap:anywhere;background:transparent}#files button:hover{background:#efeafa}.terminal{border:1px solid #e6e0ed;border-radius:8px;padding:11px;margin:8px 0;font:11px/1.65 ui-monospace,monospace;overflow-wrap:anywhere}.terminal span{color:#8c6ca9}.terminal.running span{color:#338269}.section{margin-top:32px}#status{font-size:11px;color:#9a8bb0}#drawer{display:none}dialog{border:1px solid #ded6eb;border-radius:14px;padding:0;width:min(850px,94vw);max-height:85dvh;box-shadow:0 20px 100px #30244035}dialog::backdrop{background:#241c3c55}dialog header{height:54px;padding:12px 18px}dialog strong{font:12px ui-monospace,monospace;overflow-wrap:anywhere}dialog pre{font:12px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;margin:0;max-height:65dvh;overflow:auto}.empty{color:#a399af;font-size:12px;line-height:1.7}#alert{color:#a43248;padding:0 24px;white-space:pre-wrap}
@media(max-width:760px){header{padding:0 14px}header small{display:none}.layout{display:block}main{height:100%}#drawer{display:block}aside{display:none;position:fixed;right:0;top:66px;bottom:0;width:min(320px,100vw);box-shadow:-20px 0 70px #3e29452b;z-index:3}aside.open{display:block}#conversation{padding:18px 16px}.intro{margin-top:35px}.intro h1{font-size:29px}.composer{padding:12px}.message.user{margin-left:6%}.tag{max-width:115px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.footnote{font-size:9px}.prompts small{font-size:11px}.prompts button{padding:12px}}
@media(max-width:420px){header{gap:7px;padding:0 10px}header>.tag,#status{display:none}#new{padding:8px}header>svg{width:16px}}
</style></head><body>
<header><svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z"/></svg><strong>four-tools</strong><small>Local agent workspace</small><span class="tag" id="model">connecting</span><span class="spacer"></span><span id="status">Starting</span><button id="drawer" aria-label="Toggle workspace"><svg viewBox="0 0 24 24"><path d="M3 5h18v14H3zM15 5v14"/></svg></button><button id="new">New session</button></header>
<div class="layout"><main><div id="conversation"><div class="intro" id="intro"><div class="label">READ · WRITE · EDIT · SHELL</div><h1>A small workspace.<br>Four useful tools.</h1><p class="muted">Ask the agent to build, inspect, or explore.<br>Watch the files and commands take shape beside the conversation.</p><div class="prompts"><button data-prompt="0"><span class="num">01</span><span><b>Build it. Test it. Improve it.</b><small>Create a file, edit it, and run a small test.</small></span></button><button data-prompt="1"><span class="num">02</span><span><b>Let a long command finish.</b><small>Hand off to a terminal, then hear the result.</small></span></button><button data-prompt="2"><span class="num">03</span><span><b>Turn sample data into an answer.</b><small>Write a tiny analysis tool and run it.</small></span></button></div></div></div><div id="alert" role="alert"></div><div class="composer"><form class="compose-row" id="form"><textarea id="input" rows="2" placeholder="What would you like to work on?" aria-label="Message"></textarea><button class="send" type="submit" aria-label="Send message"><svg viewBox="0 0 24 24"><path d="m5 12 7-7 7 7M12 5v15"/></svg></button></form><div class="footnote">Tools use your local account permissions. This workspace is not a security sandbox.</div></div></main><aside id="sidebar"><h2>Workspace</h2><div class="workspace-path" id="workspace"></div><div id="files"><p class="empty">No files yet. Try a task to get started.</p></div><div class="section"><h2>Managed terminals</h2><div id="terminals"><p class="empty">Long commands appear here.</p></div></div></aside></div>
<dialog id="preview"><header><strong id="filename"></strong><span class="spacer"></span><button id="close-preview" aria-label="Close preview">Close</button></header><pre id="filecontent"></pre></dialog>
<script>
'use strict';
const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') || sessionStorage.getItem('four-tools-token') || '';
if(token) sessionStorage.setItem('four-tools-token', token);
if(location.hash) history.replaceState(null,'',location.pathname);
let sessionId = sessionStorage.getItem('four-tools-session') || '', controller, lastId = 0, turn, retryTimer, refreshTimer, sending = false;
const cards = new Map();
const welcome = $('intro').outerHTML;
const prompts = [
 'Use write to create add.mjs and add.test.mjs with Node built-in tests. Use read to inspect them, edit to improve one test, and shell to run node --test add.test.mjs. Report the result.',
 'Run shell with command "printf \'starting background check\\n\'; sleep 33; printf \'background check complete\\n\'" and timeout 30. Report the handoff terminal id. When terminal_exit arrives, read the terminal log and report the final result without asking me to send another message.',
 'Use write to create a small CSV dataset and a Node script that calculates totals and averages by category without dependencies. Use shell to run the script, read the output, and summarize the findings.'
];
function error(e){ $('alert').textContent = e.message || String(e); }
async function api(path, options={}){ const r = await fetch(path,{...options,headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json',...options.headers}}); if(!r.ok){let data;try{data=await r.json()}catch{}throw new Error(data?.error || 'HTTP '+r.status)}return r.json(); }
function path(name){return '/api/'+name+'?sessionId='+encodeURIComponent(sessionId);}
function message(kind,text){const el=document.createElement('div');el.className='message '+kind;el.textContent=text;$('conversation').append(el);return el;}
function scroll(){const el=$('conversation');if(el.scrollHeight-el.scrollTop-el.clientHeight < 500)el.scrollTop=el.scrollHeight;}
function event(e){
 if(e.type==='snapshot'){ $('model').textContent=e.model;$('workspace').textContent=e.workspace;return; }
 const seq=Number(e._eventId);if(seq && seq<=lastId)return;if(seq)lastId=seq;
 $('intro')?.remove();
 if(e.type==='user_message')message('user',e.content);
 if(e.type==='turn_start'){turn=undefined;$('status').textContent='Working';}
 if(e.type==='thinking_delta'){if(!turn)turn={};if(!turn.thinking){const el=document.createElement('details');el.className='reasoning';const title=document.createElement('summary');title.textContent='Reasoning';const text=document.createElement('pre');el.append(title,text);$('conversation').append(el);turn.thinking=text;}turn.thinking.textContent+=e.delta;}
 if(e.type==='text_delta'){if(!turn)turn={};if(!turn.text)turn.text=message('assistant','');turn.text.textContent+=e.delta;}
 if(e.type==='tool_call_start'){const el=document.createElement('details');el.className='tool';const title=document.createElement('summary');title.textContent=e.name+' · running';const input=document.createElement('pre');input.textContent=JSON.stringify(e.input,null,2);const output=document.createElement('pre');output.textContent='Waiting for output…';el.append(title,input,output);$('conversation').append(el);cards.set(e.toolCallId,{el,title,output,name:e.name});if(turn)turn.text=undefined;}
 if(e.type==='tool_call_end'){const card=cards.get(e.toolCallId);if(card){card.title.textContent=card.name+' · '+(e.error?'error':'finished');card.output.textContent=e.error || e.output || '(no output)';card.el.classList.add('done');}void refresh();}
 if(e.type==='error')message('error',e.message);
 if(e.type==='turn_end'){$('status').textContent='Ready';void refresh();}
 scroll();
}
async function stream(){
 controller?.abort();const active=new AbortController();controller=active;
 try{const r=await fetch(path('stream')+'&since='+lastId,{headers:{Authorization:'Bearer '+token},signal:active.signal});if(!r.ok)throw new Error('Stream HTTP '+r.status);$('status').textContent='Connected';const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let split;while((split=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);for(const line of frame.split('\n'))if(line.startsWith('data: '))event(JSON.parse(line.slice(6)));}}if(!active.signal.aborted)throw new Error('Stream disconnected');}
 catch(e){if(active.signal.aborted)return;$('status').textContent='Reconnecting';retryTimer=setTimeout(()=>void stream(),1000);}
}
async function refresh(){
 if(!sessionId)return;
 try{const [tree,terminals]=await Promise.all([api(path('files')),api(path('terminals'))]);$('workspace').textContent=tree.workspace;$('files').replaceChildren();if(!tree.files.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='No files yet. Try a task to get started.';$('files').append(empty);}for(const file of tree.files){const b=document.createElement('button');b.textContent=(file.directory?'▸ ':'')+file.path+(file.symlink?' (symlink)':'');b.disabled=file.directory;b.onclick=()=>void showFile(file.path);$('files').append(b);}$('terminals').replaceChildren();for(const t of terminals){const el=document.createElement('div');el.className='terminal '+t.status;const name=document.createElement('b');name.textContent=t.name || '(unnamed)';const status=document.createElement('span');status.textContent=' · '+t.status+(t.exitCode===null?'':' ('+t.exitCode+')');const command=document.createElement('div');command.textContent=t.command;el.append(name,status,command);$('terminals').append(el);}if(!terminals.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='Long commands appear here.';$('terminals').append(empty);}}
 catch(e){error(e);}
}
async function showFile(file){try{const data=await api(path('files')+'&path='+encodeURIComponent(file));$('filename').textContent=data.path;$('filecontent').textContent=data.isBinary?'Binary file':data.content+(data.truncatedByBytes?'\n[Preview byte limit reached]':'');$('preview').showModal();}catch(e){error(e);}}
async function init(fresh=false){clearTimeout(retryTimer);controller?.abort();if(fresh){sessionId='';lastId=0;turn=undefined;cards.clear();$('conversation').innerHTML=welcome;}if(sessionId){try{await api(path('terminals'));}catch{sessionId='';lastId=0;}}if(!sessionId){const data=await api('/api/sessions',{method:'POST',body:'{}'});sessionId=data.sessionId;sessionStorage.setItem('four-tools-session',sessionId);$('model').textContent=data.model;}await refresh();void stream();}
async function send(text){if(!text.trim() || sending)return;sending=true;$('alert').textContent='';try{await api(path('messages'),{method:'POST',body:JSON.stringify({content:text})});$('input').value='';}catch(e){error(e);}finally{sending=false;}}
$('form').onsubmit=e=>{e.preventDefault();void send($('input').value);};$('input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send($('input').value);}};
$('conversation').addEventListener('click',e=>{const b=e.target.closest('[data-prompt]');if(b)void send(prompts[Number(b.dataset.prompt)]);});
$('new').onclick=()=>void init(true).catch(error);$('drawer').onclick=()=>$('sidebar').classList.toggle('open');$('close-preview').onclick=()=>$('preview').close();
void init().catch(e=>{error(e);sessionStorage.removeItem('four-tools-session');sessionId='';});refreshTimer=setInterval(()=>void refresh(),2000);
window.addEventListener('pagehide',()=>{controller?.abort();clearTimeout(retryTimer);clearInterval(refreshTimer);});
</script></body></html>`;

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const app = await startWebAgent();
  console.log(
    `four-tools Web Agent: ${app.url}/#token=${app.token}\nWorkspace: ${app.workspace}\nLocal account permissions apply. Keep the access URL private.`,
  );
  const stop = () => {
    void app.close().catch(console.error);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
