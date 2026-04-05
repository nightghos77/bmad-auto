import React from 'react';
import { Box, Text } from 'ink';
import type { SprintStatus } from '../types.js';
import { humanizeStoryKey } from '../state.js';

interface SprintBoardProps {
  status: SprintStatus;
  epicNames?: Record<string, string>;
  epicDescriptions?: Record<string, string>;
  currentStory?: string;
  currentSkill?: string;
  selectedIndex?: number;
  expandedStory?: string;
  storyKeys: string[];
  focused: boolean;
}

const STATUS_ICONS: Record<string, string> = {
  'done': '✅', 'in-progress': '🔄', 'review': '🔍',
  'ready-for-dev': '📋', 'backlog': '⏳', 'optional': '⚪',
};

const STATUS_COLORS: Record<string, string> = {
  'done': 'green', 'in-progress': 'cyan', 'review': 'yellow',
  'ready-for-dev': 'blue', 'backlog': 'gray', 'optional': 'gray',
};

function ProgressBar({ done, total }: { done: number; total: number }) {
  const width = 20;
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return <Text color="cyan">[{bar}] {done}/{total} ({pct}%)</Text>;
}

function StoryDetail({ storyKey, status: storyStatus }: { storyKey: string; status: string }) {
  return (
    <Box flexDirection="column" marginLeft={6} marginBottom={1} paddingX={1}
      borderStyle="single" borderColor="gray">
      <Text bold color="blue">{'  '}Story: {storyKey}</Text>
      <Text dimColor>{'  '}Status: <Text color={STATUS_COLORS[storyStatus] || 'white'}>{storyStatus}</Text></Text>
      <Text dimColor>{'  '}Press Enter again to collapse</Text>
    </Box>
  );
}

export function SprintBoard({ status, epicNames = {}, epicDescriptions = {}, currentStory, currentSkill, selectedIndex, expandedStory, storyKeys, focused }: SprintBoardProps) {
  const entries = Object.entries(status.development_status);

  // Group stories by epic
  const epics: { key: string; status: string; stories: [string, string][] }[] = [];
  let currentEpic: typeof epics[0] | null = null;

  for (const [key, value] of entries) {
    if (key.startsWith('epic-') && !key.endsWith('-retrospective')) {
      currentEpic = { key, status: value, stories: [] };
      epics.push(currentEpic);
    } else if (key.endsWith('-retrospective')) {
      // skip
    } else if (currentEpic) {
      currentEpic.stories.push([key, value]);
    }
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={focused ? 'cyan' : 'white'}>
          {'  '}BMAD Autopilot — Sprint Board
          {focused ? <Text dimColor> (focused)</Text> : null}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>{'  '}Project: {status.project}</Text>
      </Box>
      {epics.map((epic) => {
        const doneCount = epic.stories.filter(([, s]) => s === 'done').length;
        const totalCount = epic.stories.length;
        return (
          <Box key={epic.key} flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold>{'  '}{STATUS_ICONS[epic.status] || '⏳'} {epic.key}{epicNames[epic.key] ? `: ${epicNames[epic.key]}` : ''} </Text>
              <ProgressBar done={doneCount} total={totalCount} />
            </Box>
            {epicDescriptions[epic.key] ? (
              <Box marginLeft={5}>
                <Text dimColor italic wrap="wrap">{'  '}{epicDescriptions[epic.key]}</Text>
              </Box>
            ) : null}
            {epic.stories.map(([storyKey, storyStatus]) => {
              const isActive = storyKey === currentStory;
              const storyIdx = storyKeys.indexOf(storyKey);
              const isSelected = focused && selectedIndex === storyIdx;
              const isExpanded = expandedStory === storyKey;
              const icon = STATUS_ICONS[storyStatus] || '⏳';
              const color = STATUS_COLORS[storyStatus] || 'white';
              const chevron = isExpanded ? '▼' : '▶';

              return (
                <Box key={storyKey} flexDirection="column">
                  <Box>
                    <Text>
                      {isSelected ? <Text color="magenta" bold>{' ▸ '}</Text> : '    '}
                      <Text dimColor>{chevron} </Text>
                      <Text>{icon} </Text>
                      <Text color={color as any} bold={isSelected}>
                        {storyKey} — {humanizeStoryKey(storyKey)}: {storyStatus}
                      </Text>
                      {isActive && currentSkill ? (
                        <Text color="cyan"> ← {currentSkill} ⟳</Text>
                      ) : null}
                    </Text>
                  </Box>
                  {isExpanded ? (
                    <StoryDetail storyKey={storyKey} status={storyStatus} />
                  ) : null}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}
