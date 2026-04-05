import React from 'react';
import { Box, Text } from 'ink';

interface LogStreamProps {
  lines: string[];
  maxLines?: number;
  scrollOffset?: number;
  focused?: boolean;
}

function colorForLine(line: string): string | undefined {
  if (line.startsWith('✓') || line.startsWith('[done]')) return 'green';
  if (line.startsWith('✗') || line.startsWith('[err]') || line.includes('HALT')) return 'red';
  if (line.startsWith('▶') || line.includes('Gate')) return 'cyan';
  if (line.startsWith('[tool]')) return 'magenta';
  return undefined;
}

export function LogStream({ lines, maxLines = 20, scrollOffset = 0, focused = false }: LogStreamProps) {
  const end = lines.length - scrollOffset;
  const start = Math.max(0, end - maxLines);
  const visible = lines.slice(start, end > 0 ? end : undefined);

  const scrollInfo = scrollOffset > 0
    ? ` (scroll: +${scrollOffset})`
    : lines.length > maxLines
    ? ` (${lines.length} total)`
    : '';

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}
      borderStyle="single" borderColor={focused ? 'cyan' : 'gray'}>
      <Text bold dimColor={!focused}>
        {'  '}Live Output{scrollInfo}
        {focused ? <Text color="cyan"> (focused — ↑↓ scroll, G bottom)</Text> : null}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>{'  '}Waiting for output...</Text>
      ) : (
        visible.map((line, i) => (
          <Text key={start + i} color={colorForLine(line)} dimColor={!colorForLine(line)} wrap="truncate">
            {'  '}{line}
          </Text>
        ))
      )}
    </Box>
  );
}
