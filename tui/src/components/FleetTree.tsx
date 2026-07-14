import React from 'react';
import { Box, Text } from 'ink';
import type { NodeRow } from '../viewModel.js';

const STATE_COLOR: Record<string, string> = {
  submitted: 'gray',
  working: 'cyan',
  'input-required': 'yellow',
  completed: 'green',
  failed: 'red',
  canceled: 'red',
  rejected: 'red',
};

export interface FleetTreeProps {
  rows: NodeRow[];
  selectedNodeId?: string;
}

export function FleetTree({ rows, selectedNodeId }: FleetTreeProps) {
  return (
    <Box flexDirection="column">
      <Text bold underline>Fleet</Text>
      {rows.length === 0 && <Text dimColor>(no nodes yet)</Text>}
      {rows.map(row => {
        const selected = row.id === selectedNodeId;
        const indent = '  '.repeat(row.depth);
        const marker = selected ? '›' : ' ';
        const glyph = row.isCaptain ? '⚑' : '·';
        return (
          <Box key={row.id}>
            <Text bold={selected} inverse={selected}>
              {marker} {indent}{glyph} {row.role}{' '}
            </Text>
            <Text color="magenta">[{row.driver || 'unknown'}]</Text>
            <Text> </Text>
            <Text color={STATE_COLOR[row.state] ?? 'white'}>{row.state}</Text>
            <Text dimColor> ${row.costUsd.toFixed(2)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
