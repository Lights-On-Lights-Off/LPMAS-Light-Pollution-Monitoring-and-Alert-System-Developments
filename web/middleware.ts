import {NextRequest, NextResponse} from 'next/server';
import {permitsApiMutation} from '@/lib/request-origin';

export function middleware(request: NextRequest) {
  // Host is the browser's destination; nextUrl may use an internal server name.
  if (!permitsApiMutation(request.method, request.headers.get('host'), request.headers.get('origin'), request.headers.get('sec-fetch-site'))) {
    return NextResponse.json({error:'Cross-origin changes are not permitted.'},{status:403});
  }
  return NextResponse.next();
}
export const config = {matcher:'/api/:path*'};
