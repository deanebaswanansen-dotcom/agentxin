import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeStoryMemory } from '../test/storyMemoryFixture.js';
import { StoryMemoryDrawer } from './StoryMemoryDrawer.js';

afterEach(() => vi.restoreAllMocks());
describe('StoryMemoryDrawer keyboard navigation', () => {
  it('focuses the dialog, traps Tab, closes with Escape and returns to its trigger', async () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 10, height: 10 }] as unknown as DOMRectList);
    const client = { storyMemory: { workspace: vi.fn().mockResolvedValue(makeStoryMemory({ entries: [], unverifiedReferences: [], acceptedSources: [] })) } } as unknown as NonNullable<Parameters<typeof StoryMemoryDrawer>[0]['client']>;
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开记忆</button>{open ? <StoryMemoryDrawer projectId="p-1" mode="novel" client={client} onClose={() => setOpen(false)} /> : null}</>;
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开记忆' }); trigger.focus(); fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: '关闭故事记忆' });
    expect(close).toHaveFocus();
    const last = await screen.findByText('已接受来源（0）');
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' }); expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '故事记忆' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
