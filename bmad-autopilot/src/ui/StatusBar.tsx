import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  currentSkill?: string;
  currentStory?: string;
  startTime?: number;
  outcome?: 'running' | 'complete' | 'halted' | 'interrupted';
  storiesProcessed?: number;
  haltReason?: string;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function StatusBar({
  currentSkill,
  currentStory,
  startTime,
  outcome = 'running',
  storiesProcessed = 0,
  haltReason,
}: StatusBarProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (outcome !== 'running' || !startTime) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 1000);
    return () => clearInterval(interval);
  }, [outcome, startTime]);

  if (outcome === 'complete') {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color="green" bold>
          ✅ Sprint Complete | {storiesProcessed} stories | {formatDuration(elapsed)}
        </Text>
      </Box>
    );
  }

  if (outcome === 'halted') {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color="red" bold>
          ⛔ HALTED: {haltReason || 'Unknown'} | {currentStory}
        </Text>
      </Box>
    );
  }

  if (outcome === 'interrupted') {
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color="yellow" bold>
          ⏸ Interrupted | {storiesProcessed} stories processed
        </Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1} marginTop={1}>
      <Text color="cyan">
        ▶ {currentSkill || 'starting'} | {currentStory || '...'} | {formatDuration(elapsed)}
      </Text>
    </Box>
  );
}
