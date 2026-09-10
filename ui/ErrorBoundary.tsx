import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typography } from './theme';

/**
 * Global error boundary.
 *
 * A crashed render must never leave the operator looking at an empty screen in
 * the field: the boundary states what happened, keeps the technical detail
 * visible, and offers a reload. Saved data is untouched by a render failure.
 */
interface Props {
  children: ReactNode;
  title: string;
  body: string;
  reloadLabel: string;
  detailLabel: string;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, componentStack: info.componentStack ?? null });
  }

  private reset = () => {
    this.setState({ error: null, componentStack: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>{this.props.title}</Text>
        <Text style={styles.body}>{this.props.body}</Text>
        <View style={styles.detailBox}>
          <Text style={styles.detailLabel}>{this.props.detailLabel}</Text>
          <Text style={styles.detail}>{error.message || String(error)}</Text>
          {this.state.componentStack ? (
            <Text style={styles.stack} numberOfLines={12}>
              {this.state.componentStack.trim()}
            </Text>
          ) : null}
        </View>
        <Pressable style={styles.button} onPress={this.reset} accessibilityRole="button">
          <Text style={styles.buttonLabel}>{this.props.reloadLabel}</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.xl,
    justifyContent: 'center',
    gap: spacing.md,
  },
  title: { ...typography.title, color: colors.error },
  body: { ...typography.body, color: colors.text },
  detailBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  detailLabel: { ...typography.small, color: colors.textMuted },
  detail: { ...typography.small, color: colors.warning },
  stack: { ...typography.small, color: colors.textFaint },
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { ...typography.sectionTitle, color: colors.background },
});
