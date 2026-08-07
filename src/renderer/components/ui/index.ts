/**
 * The design system. Import from here, never from the individual files:
 *
 *   import { Button, Card, EmptyState } from '../../components/ui';
 *
 * No Radix, no headless-ui — the dependency count stays low, so these are
 * hand-built. That means accessibility is our job: every primitive here has
 * real focus management, keyboard operation and aria wiring, and anything new
 * added alongside them is expected to match.
 */
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { Badge, StatusDot, type BadgeProps, type BadgeVariant, type StatusDotProps } from './Badge';
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardContentProps,
  type CardHeaderProps,
  type CardProps,
} from './Card';
export { CodeBlock, type CodeBlockProps } from './CodeBlock';
export {
  CollapsibleSection,
  type CollapsibleSectionProps,
} from './CollapsibleSection';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
export { Dialog, type DialogProps } from './Dialog';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Field, describedBy, type FieldProps } from './Field';
export { Input, type InputProps } from './Input';
export { Select, type SelectOption, type SelectProps } from './Select';
export { Spinner, type SpinnerProps } from './Spinner';
export { Switch, type SwitchProps } from './Switch';
export {
  Table,
  TableBody,
  TableCell,
  TableEmptyRow,
  TableHead,
  TableHeaderCell,
  TableRow,
  type TableCellProps,
  type TableHeaderCellProps,
  type TableProps,
  type TableRowProps,
} from './Table';
export { Tabs, type TabItem, type TabsProps } from './Tabs';
export { Toaster } from './Toast';
export { Textarea, type TextareaProps } from './Textarea';
export { Tooltip, type TooltipProps, type TooltipSide } from './Tooltip';
export * from './styles';
