export type Agent = {
  /** Short label shown in the pane: a-01, a-02… */
  label: string
  /** The Agent call's tool_use_id, used to match agent.spawn */
  callId: string
  /** The real agentId, known after spawn; every child tool.call carries it */
  id?: string
  desc: string
  type: string
  model: string
  effort: string
  /** Its own turn's id, what the stop button ends */
  turnId?: string
  startedAt: number
  endedAt?: number
  tools: number
  /** Tokens its own requests paid for: uncached input, cache writes, output. */
  tok: number
}

export type Todo = { content: string; status: string }

/** One risk zone read from the project's CLAUDE.md: a short label and its terms. */
export type Zone = { label: string; terms: string[] }

declare module 'claude-code' {
  interface PluginState {
    'swarm-pane': {
      agents: Agent[]
      todos: Todo[]
      tick: number
      zones: Zone[]
      turnAt: number
      /** Whose transcript the log pane draws: an agentId, '' for none. */
      logFor: string
      /** Who wrote the task list: '' for the main loop, else an agentId. */
      todoFrom: string
    }
  }
}
