import React, { useState, useEffect, useMemo } from 'react';
import { resolve, dirname } from 'node:path';
import { Box, Text, useInput } from 'ink';
import { SprintBoard } from './SprintBoard.js';
import { StatusBar } from './StatusBar.js';
import { LogStream } from './LogStream.js';
import { loadSprintStatus, isStoryKey, parseEpicNames, parseEpicDescriptions } from '../state.js';
import { runnerEvents } from '../runner.js';
import { orchestratorEvents } from '../orchestrator.js';
import type { SprintStatus } from '../types.js';

interface AppProps {
  statusFile: string;
  epicsFile?: string;
  initialStatus: SprintStatus;
}

type FocusPanel = 'board' | 'log';

export function App({ statusFile, epicsFile, initialStatus }: AppProps) {
  const [status, setStatus] = useState<SprintStatus>(initialStatus);

  // Load epic names and descriptions from epics.md for display
  const resolvedEpicsFile = useMemo(() => {
    if (epicsFile) return epicsFile;
    const planningDir = resolve(dirname(statusFile), '..', 'planning-artifacts');
    return resolve(planningDir, 'epics.md');
  }, [epicsFile, statusFile]);

  const epicNames = useMemo(() => parseEpicNames(resolvedEpicsFile), [resolvedEpicsFile]);
  const epicDescriptions = useMemo(() => parseEpicDescriptions(resolvedEpicsFile), [resolvedEpicsFile]);
  const [currentSkill, setCurrentSkill] = useState<string | undefined>();
  const [currentStory, setCurrentStory] = useState<string | undefined>();
  const [startTime] = useState(Date.now());
  const [outcome, setOutcome] = useState<'running' | 'complete' | 'halted' | 'interrupted'>('running');
  const [storiesProcessed, setStoriesProcessed] = useState(0);
  const [haltReason, setHaltReason] = useState<string | undefined>();
  const [logLines, setLogLines] = useState<string[]>([]);

  // Interactive state
  const [focusPanel, setFocusPanel] = useState<FocusPanel>('board');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedStory, setExpandedStory] = useState<string | undefined>();
  const [logScroll, setLogScroll] = useState(0);

  // Build flat list of story keys for navigation
  const storyKeys = useMemo(() => {
    return Object.keys(status.development_status).filter(k => isStoryKey(k));
  }, [status]);

  // Keyboard input
  useInput((input, key) => {
    if (key.tab) {
      setFocusPanel(prev => prev === 'board' ? 'log' : 'board');
      return;
    }

    if (focusPanel === 'board') {
      if (key.upArrow) {
        setSelectedIndex(prev => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex(prev => Math.min(storyKeys.length - 1, prev + 1));
      } else if (key.return) {
        const key2 = storyKeys[selectedIndex];
        if (key2) {
          setExpandedStory(prev => prev === key2 ? undefined : key2);
        }
      }
    } else if (focusPanel === 'log') {
      if (key.upArrow) {
        setLogScroll(prev => Math.max(0, prev + 1));
      } else if (key.downArrow) {
        setLogScroll(prev => Math.max(0, prev - 1));
      } else if (input === 'g' || input === 'G') {
        setLogScroll(0); // jump to bottom
      }
    }
  });

  // Event wiring
  useEffect(() => {
    const onSkillStart = (data: { skill: string; storyKey: string }) => {
      setCurrentSkill(data.skill);
      setCurrentStory(data.storyKey);
      setLogLines(prev => [...prev, `▶ Starting ${data.skill} on ${data.storyKey}`]);
    };

    const onSkillOutput = (data: { line: string; type: string }) => {
      const prefix = data.type === 'tool' ? '[tool] '
        : data.type === 'stderr' ? '[err] '
        : data.type === 'result' ? '[done] '
        : '';
      setLogLines(prev => {
        const next = [...prev, prefix + data.line];
        return next.length > 500 ? next.slice(-500) : next;
      });
      setLogScroll(0); // auto-scroll to bottom on new output
    };

    const onSkillComplete = (data: { skill: string; storyKey: string; durationMs: number }) => {
      setLogLines(prev => [...prev, `✓ ${data.skill} completed in ${Math.round(data.durationMs / 1000)}s`]);
      setStoriesProcessed(prev => prev + 1);
      try { setStatus(loadSprintStatus(statusFile)); } catch { /* ignore */ }
    };

    const onSkillError = (data: { skill: string; exitCode: number }) => {
      setLogLines(prev => [...prev, `✗ ${data.skill} failed (exit ${data.exitCode})`]);
    };

    const onSkillTimeout = (data: { skill: string }) => {
      setLogLines(prev => [...prev, `⏱ ${data.skill} timed out`]);
    };

    const onLog = (message: string) => {
      setLogLines(prev => [...prev, message]);
      setLogScroll(0);
    };

    const onOutcome = (newOutcome: 'complete' | 'interrupted') => {
      setOutcome(newOutcome);
      setCurrentSkill(undefined);
      try { setStatus(loadSprintStatus(statusFile)); } catch { /* ignore */ }
    };

    const onHalt = (reason: string, story: string) => {
      setOutcome('halted');
      setHaltReason(reason);
      setCurrentStory(story);
      setCurrentSkill(undefined);
      try { setStatus(loadSprintStatus(statusFile)); } catch { /* ignore */ }
    };

    const onGate = (result: { gate: string; passed: boolean; details: string }) => {
      const icon = result.passed ? '✓' : '✗';
      setLogLines(prev => [...prev, `${icon} Gate [${result.gate}]: ${result.details}`]);
    };

    runnerEvents.on('skill_start', onSkillStart);
    runnerEvents.on('skill_output', onSkillOutput);
    runnerEvents.on('skill_complete', onSkillComplete);
    runnerEvents.on('skill_error', onSkillError);
    runnerEvents.on('skill_timeout', onSkillTimeout);
    orchestratorEvents.on('log', onLog);
    orchestratorEvents.on('outcome', onOutcome);
    orchestratorEvents.on('halt', onHalt);
    orchestratorEvents.on('gate', onGate);

    return () => {
      runnerEvents.off('skill_start', onSkillStart);
      runnerEvents.off('skill_output', onSkillOutput);
      runnerEvents.off('skill_complete', onSkillComplete);
      runnerEvents.off('skill_error', onSkillError);
      runnerEvents.off('skill_timeout', onSkillTimeout);
      orchestratorEvents.off('log', onLog);
      orchestratorEvents.off('outcome', onOutcome);
      orchestratorEvents.off('halt', onHalt);
      orchestratorEvents.off('gate', onGate);
    };
  }, [statusFile]);

  return (
    <Box flexDirection="column">
      <SprintBoard
        status={status}
        epicNames={epicNames}
        epicDescriptions={epicDescriptions}
        currentStory={currentStory}
        currentSkill={currentSkill}
        selectedIndex={focusPanel === 'board' ? selectedIndex : undefined}
        expandedStory={expandedStory}
        storyKeys={storyKeys}
        focused={focusPanel === 'board'}
      />
      <StatusBar
        currentSkill={currentSkill}
        currentStory={currentStory}
        startTime={startTime}
        outcome={outcome}
        storiesProcessed={storiesProcessed}
        haltReason={haltReason}
      />
      <LogStream
        lines={logLines}
        scrollOffset={logScroll}
        focused={focusPanel === 'log'}
      />
      <Box paddingX={1}>
        <Text dimColor>
          {'  '}Tab: switch panel  |  ↑↓: navigate  |  Enter: expand story  |  G: jump to bottom
        </Text>
      </Box>
    </Box>
  );
}
