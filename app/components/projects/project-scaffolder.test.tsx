// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ clone: vi.fn(), picker: vi.fn(), refetch: vi.fn() }))
vi.mock('@/conveyor/client', () => ({
  conveyor: {
    projects: {
      list: { useQuery: () => ({ data: [], refetch: mocks.refetch }) },
      executions: { useQuery: () => ({ data: [], refetch: mocks.refetch }) },
      pickDestination: mocks.picker,
      clone: mocks.clone,
    },
  },
}))
import { ProjectScaffolder } from './project-scaffolder'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('defaults to no commands and forwards the checkbox through the typed clone call', async () => {
  mocks.picker.mockResolvedValue('C:\\Projects')
  mocks.clone.mockResolvedValue({ project: { name: 'my-electron-app' }, warning: null })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ProjectScaffolder />))
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    const scaffold = container.querySelector('button[type="submit"]') as HTMLButtonElement
    expect(checkbox.checked).toBe(false)
    expect(scaffold.disabled).toBe(true)
    await act(async () => (container.querySelector('#project-directory') as HTMLButtonElement).click())
    expect(scaffold.disabled).toBe(false)
    await act(async () => scaffold.click())
    expect(mocks.clone).toHaveBeenLastCalledWith({ name: 'my-electron-app', runDev: false })
    await act(async () => checkbox.click())
    await act(async () => scaffold.click())
    expect(mocks.clone).toHaveBeenLastCalledWith({ name: 'my-electron-app', runDev: true })
    expect(container.querySelectorAll('th')).toHaveLength(4)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
