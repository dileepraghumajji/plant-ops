'use client';

/**
 * An antd `Table` wired to the IAM's pagination envelope (Doc 06 §1).
 *
 * Every list screen in every console — users, roles, clients, applications,
 * bindings, service accounts, audit — receives `{ data, page, limit, total }`
 * and has to turn it into a table with server-side paging. Doing that by hand
 * per screen is where the same three mistakes appear: reading `data.length` as
 * the total (so the pager shows one page of a thousand rows), losing the page
 * on a refetch, and rendering an empty table where a "no results" explanation
 * belongs.
 *
 * The component is generic over the row type and passes antd's `columns`
 * through untouched, so it constrains nothing about how a screen looks — only
 * about how it talks to the API.
 */

import type { Paginated } from '@plantops/contracts';
import { MAX_PAGE_SIZE } from '@plantops/contracts';
import { Table, type TableProps } from 'antd';
import * as React from 'react';

import { ScreenEmpty } from '../feedback/state-panels';

export interface DataTableQuery {
  page: number;
  limit: number;
}

export interface DataTableProps<T> {
  /** The envelope. `undefined` while the first page is in flight. */
  result: Paginated<T> | undefined;
  columns: TableProps<T>['columns'];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Fired when the pager moves. The caller refetches and passes the result back. */
  onQueryChange?: (query: DataTableQuery) => void;
  /** Shown instead of the table body when the result is empty. */
  empty?: React.ReactNode;
  /** Replaces the whole table — for a failed load. */
  error?: React.ReactNode;
  size?: TableProps<T>['size'];
  onRowClick?: (row: T) => void;
  /** Selection, expansion and the rest of antd's surface, when a screen needs it. */
  tableProps?: Omit<
    TableProps<T>,
    'columns' | 'dataSource' | 'rowKey' | 'loading' | 'pagination' | 'onChange'
  >;
}

export function DataTable<T>({
  result,
  columns,
  rowKey,
  loading = false,
  onQueryChange,
  empty,
  error,
  size = 'middle',
  onRowClick,
  tableProps,
}: DataTableProps<T>): React.ReactNode {
  if (error !== undefined) return error;

  const rows = result?.data ?? [];

  return (
    <Table<T>
      {...tableProps}
      columns={columns}
      dataSource={rows}
      rowKey={rowKey}
      loading={loading}
      size={size}
      locale={{
        emptyText: loading ? ' ' : (empty ?? <ScreenEmpty />),
      }}
      onRow={
        onRowClick === undefined
          ? tableProps?.onRow
          : (row) => ({ onClick: () => onRowClick(row), style: { cursor: 'pointer' } })
      }
      pagination={
        result === undefined
          ? false
          : {
              current: result.page,
              pageSize: result.limit,
              total: result.total,
              // The server refuses anything above MAX_PAGE_SIZE (Doc 06 §1), so
              // offering a larger option would be offering a 400.
              pageSizeOptions: [10, 25, 50, MAX_PAGE_SIZE].map(String),
              showSizeChanger: true,
              showTotal: (total, [from, to]) => `${from}–${to} of ${total}`,
            }
      }
      onChange={(pagination) => {
        onQueryChange?.({
          page: pagination.current ?? 1,
          limit: pagination.pageSize ?? (result?.limit ?? 25),
        });
      }}
      scroll={{ x: 'max-content' }}
    />
  );
}
