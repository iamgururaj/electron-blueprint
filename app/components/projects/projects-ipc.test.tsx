import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { createCaller, type Router } from 'electron-conveyor/define'
import type { AppContext } from '@/conveyor/init'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  realpath: vi.fn(),
  picker: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
  terminal: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: () => '/userdata' }, dialog: { showOpenDialog: mocks.picker } }))
vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  rename: mocks.rename,
  stat: mocks.stat,
  realpath: mocks.realpath,
}))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, spawn: mocks.spawn }))
vi.mock('@/lib/main/project-terminal', () => ({ openProjectTerminal: mocks.terminal, executionStates: async () => [] }))
import { projectsModule } from '@/conveyor/modules/projects'

const frame = {} as WebContents['mainFrame']
const sender = { id: 42, mainFrame: frame, isDestroyed: () => false, once: vi.fn() } as unknown as WebContents
const router = { modules: { projects: projectsModule } } as Router<{ projects: typeof projectsModule }>
function caller(mainFrame = true) {
  return createCaller(router, {
    ctx: {
      appStartedAt: 0,
      windows: {} as AppContext['windows'],
      openWindow: vi.fn(),
      window: {} as BrowserWindow,
      sender,
      event: { senderFrame: mainFrame ? frame : {} } as IpcMainInvokeEvent,
    },
  }).projects
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.readFile.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }))
  mocks.realpath.mockImplementation(async (path) => path)
  mocks.stat.mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }))
  mocks.picker.mockResolvedValue({ canceled: false, filePaths: ['/selected folder'] })
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))
})

describe('Project IPC boundary', () => {
  it('requires a native folder selection and handles picker cancellation', async () => {
    await expect(caller().clone({ name: 'unselected', runDev: false })).rejects.toThrow('Choose a destination')
    mocks.picker.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await caller().pickDestination()).toBeNull()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
  it('rejects subframes before reading files', async () => {
    await expect(caller(false).list()).rejects.toThrow('main frame')
    expect(mocks.readFile).not.toHaveBeenCalled()
  })
  it('rejects traversal names and unknown terminal project IDs', async () => {
    await expect(caller().clone({ name: '../escape', runDev: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(caller().openTerminal({ id: '123e4567-e89b-42d3-a456-426614174000', runDev: true })).rejects.toThrow(
      'Unknown local project'
    )
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.terminal).not.toHaveBeenCalled()
  })
  it('clones the fixed repository into the picked parent and persists without starting npm by default', async () => {
    const api = caller()
    await api.pickDestination()
    const result = await api.clone({ name: 'my-app', runDev: false })
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['clone', '--', 'https://github.com/iamgururaj/electron-blueprint.git', result.project.path],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function)
    )
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('projects.json.tmp'),
      expect.stringContaining('my-app'),
      'utf8'
    )
    expect(mocks.rename).toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('does not overwrite an existing folder or record a failed clone', async () => {
    const api = caller()
    await api.pickDestination()
    mocks.stat.mockResolvedValueOnce({ isDirectory: () => true })
    await expect(api.clone({ name: 'existing', runDev: false })).rejects.toThrow('already exists')
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error('offline')))
    await expect(api.clone({ name: 'new-project', runDev: false })).rejects.toThrow('Clone failed')
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
  it('runs fixed dev commands in the saved cwd and preserves a clone when terminal launch fails', async () => {
    const api = caller()
    await api.pickDestination()
    mocks.stat.mockRejectedValueOnce(Object.assign(new Error(), { code: 'ENOENT' }))
    mocks.stat.mockResolvedValue({ isDirectory: () => true })
    mocks.terminal.mockRejectedValue(new Error('Could not open terminal'))
    const result = await api.clone({ name: 'dev-app', runDev: true })
    expect(result.warning).toContain('Could not open')
    expect(mocks.rename).toHaveBeenCalled()
    expect(mocks.terminal).toHaveBeenCalledWith(result.project.id, result.project.path, true, '/userdata')
  })
})
