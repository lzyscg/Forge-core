import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusChip } from './status-chip';

describe('StatusChip', () => {
  it('renders the given label', () => {
    render(<StatusChip tone="neutral" label="待启动" />);
    expect(screen.getByText('待启动')).toBeVisible();
  });

  it('applies the tone class for semantic styling', () => {
    render(<StatusChip tone="danger" label="失败" />);
    expect(screen.getByText('失败')).toHaveClass('fc-status-chip', 'fc-status-chip--danger');
  });
});
