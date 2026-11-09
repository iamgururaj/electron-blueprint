import { app, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { command, defineModule, query, middleware } from '../init'
import { openProjectTerminal, executionStates } from '../../lib/main/project-terminal'

const REPOSITORY = 'https://github.com/iamgururaj/electron-blueprint.git'
const run = promisify(execFile)
const projectSchema = z.object({ id: z.string().uuid(), name: z.string(), path: z.string() })
type Project = z.infer<typeof projectSchema>
const destinations = new Map<number, string>()
let cloning = false
const trusted = middleware(({ ctx, next }) => {
  if (!ctx.window || ctx.sender.isDestroyed() || ctx.event.senderFrame !== ctx.sender.mainFrame) {
    throw new Error('Project operations require the app main frame.')
  }
  return next()
})
const projectCommand = command.use(trusted)
const projectQuery = query.use(trusted)

async function listProjects(): Promise<Project[]> {
  try {
    return z
      .array(projectSchema)
      .parse(JSON.parse(await readFile(join(app.getPath('userData'), 'projects.json'), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Could not read the local projects registry.')
  }
}

async function launchTerminal(project: Project, dev: boolean) {
  const cwd = await realpath(project.path)
  if (!(await stat(cwd)).isDirectory()) throw new Error('Project folder is unavailable.')
  await openProjectTerminal(project.id, cwd, dev, app.getPath('userData'))
}

export const projectsModule = defineModule({
  executions: projectQuery(() => executionStates()),
  list: projectQuery(() => listProjects()),
  pickDestination: projectCommand(async ({ ctx }) => {
    const result = await dialog.showOpenDialog(ctx.window!, {
      title: 'Choose a parent folder for your new project',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = await realpath(result.filePaths[0])
    if (!destinations.has(ctx.sender.id)) {
      ctx.sender.once('destroyed', () => destinations.delete(ctx.sender.id))
    }
    destinations.set(ctx.sender.id, path)
    return path
  }),
  clone: projectCommand(
    z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/), runDev: z.boolean() }),
    async ({ ctx, input }) => {
      if (cloning) throw new Error('Another clone is already in progress.')
      const parent = destinations.get(ctx.sender.id)
      if (!parent) throw new Error('Choose a destination folder first.')
      cloning = true
      try {
        const projects = await listProjects()
        const path = join(parent, input.name)
        try {
          await stat(path)
          throw new Error('A folder with this name already exists.')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        try {
          await run('git', ['clone', '--', REPOSITORY, path], {
            timeout: 300_000,
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          })
        } catch {
          throw new Error(
            'Clone failed. Check Git and your network connection. A partial folder may remain; choose a new name or remove it before retrying.'
          )
        }
        const project = { id: randomUUID(), name: basename(path), path }
        const file = join(app.getPath('userData'), 'projects.json')
        await writeFile(`${file}.tmp`, JSON.stringify([...projects, project], null, 2), 'utf8')
        await rename(`${file}.tmp`, file)
        let warning: string | null = null
        if (input.runDev) {
          try {
            await launchTerminal(project, true)
          } catch (error) {
            warning = (error as Error).message
          }
        }
        return { project, warning }
      } finally {
        cloning = false
      }
    }
  ),
  openTerminal: projectCommand(z.object({ id: z.string().uuid(), runDev: z.boolean() }), async ({ input }) => {
    const project = (await listProjects()).find((entry) => entry.id === input.id)
    if (!project) throw new Error('Unknown local project.')
    await launchTerminal(project, input.runDev)
  }),
})
