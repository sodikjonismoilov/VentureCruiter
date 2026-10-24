import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment, renderer, load, find, textOf } from './support/component-harness.mjs';

function component() {
  const env=environment(),view=renderer(env);
  return load('../src/components/MarkdownContent.tsx',{'react-markdown':{__esModule:true,default:'markdown'},'remark-gfm':{__esModule:true,default:()=>{}},'./ChartImage.module.css':{}},{...env.globals,React:view.react.default});
}
const src='/api/conversations/3d716115-a8e1-4bee-a813-226307a004d6/attachments/d5cf4189-e263-4685-b76e-349d47ec0e36/0';

test('actual workspace attachment images render with alt text and full-size/download actions',()=>{
  const {AttachmentImage}=component();
  const tree=AttachmentImage({src,alt:'Revenue by quarter'});
  assert.equal(find(tree,node=>node.type==='img').props.src,src);
  assert.equal(find(tree,node=>node.type==='img').props.alt,'Revenue by quarter');
  assert.ok(find(tree,node=>node.type==='a'&&node.props.download));
  assert.match(textOf(tree),/Open full-size image/);
});

test('remote, data, script, protocol-relative and escaped paths never become image requests',()=>{
  const {AttachmentImage,isAttachmentImage}=component();
  for(const url of ['https://tracker.invalid/pixel','//tracker.invalid/pixel','data:image/svg+xml,<svg/>','javascript:alert(1)',src+'?next=https://tracker.invalid','/api/conversations/../../secret','/api/conversations/%2f..%2f/attachments/secret/0',null]){
    assert.equal(isAttachmentImage(url),false);
    const tree=AttachmentImage({src:url,alt:'Supplied description'});
    assert.equal(find(tree,node=>node.type==='img'),undefined);
    assert.equal(textOf(tree),'Supplied description');
  }
});

test('chart markdown retains skipHtml and the existing safe-link behavior',()=>{
  const {default:MarkdownContent}=component();
  const tree=MarkdownContent({children:'![Revenue]('+src+')'});
  assert.equal(tree.props.skipHtml,true);
  const link=tree.props.components.a({href:'https://example.com',children:'Source'});
  assert.equal(link.props.rel,'noopener noreferrer');
});
