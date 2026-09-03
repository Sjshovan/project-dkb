import type { Config, ColumnsConfig } from 'datatables.net';

export type ConsoleDataTableColumn = ColumnsConfig & { columnControl?: Config['columnControl'] };

export function consoleTextFilter(title: string): NonNullable<Config['columnControl']> { return [{
  extend: 'searchDropdown',
  text: `Filter ${title}`,
}]; }

export function consoleDateFilter(title: string): NonNullable<Config['columnControl']> { return [[{
  extend: 'searchDateTime',
  mask: 'YYYY-MM-DD',
  title: `Filter ${title}`,
  titleAttr: `Filter ${title}`,
}]]; }

export function consoleListFilter(values: readonly string[], title: string): NonNullable<Config['columnControl']> {
  return [[{
    extend: 'searchList',
    options: [...new Set(values.filter(Boolean))].sort().map((value) => ({ label: titleCase(value), value })),
    ajaxOnly: false,
    search: values.length > 8,
    select: false,
    title: `Filter ${title}`,
  }]];
}

export function consoleDataTableOptions(input: {
  searchPlaceholder: string;
  emptyTable: string;
  zeroRecords?: string;
  noun: string;
  order?: Config['order'];
  orderFixed?: Config['orderFixed'];
  pageLength?: number;
  rowCallback?: Config['rowCallback'];
  scrollY?: string;
}): Config {
  const noun = input.noun;
  return {
    autoWidth: false,
    deferRender: true,
    layout: {
      topStart: { pageLength: { menu: [10, 25, 50, 100], text: 'Rows per page _MENU_' } },
      topEnd: { search: { placeholder: input.searchPlaceholder, text: `Search ${noun}: _INPUT_` } },
      bottomStart: 'info',
      bottomEnd: { paging: { type: 'full_numbers', buttons: 7, boundaryNumbers: true, firstLast: true, previousNext: true, numbers: true } },
    },
    language: {
      emptyTable: input.emptyTable,
      info: `Showing _START_–_END_ of _TOTAL_ ${noun}`,
      infoEmpty: `Showing 0 ${noun}`,
      infoFiltered: 'filtered from _MAX_ total',
      zeroRecords: input.zeroRecords ?? `No ${noun} match the current search and filters.`,
    },
    lengthMenu: [10, 25, 50, 100],
    order: input.order ?? [[0, 'asc']],
    orderFixed: input.orderFixed,
    ordering: { indicators: true, handler: true },
    pageLength: input.pageLength ?? 10,
    paging: true,
    responsive: true,
    rowCallback: input.rowCallback,
    scrollCollapse: true,
    scrollY: input.scrollY ?? 'min(52vh, 34rem)',
  };
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
