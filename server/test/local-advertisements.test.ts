import {describe,it,expect} from 'vitest';
import {isKnownAdvertisementImage,isAdmissionAdvertisementCandidate} from '../src/utils/local-advertisements.js';

describe('user-confirmed global image advertisement filenames',()=>{
  it('recognizes 3211.jpg exactly without matching similar filenames or directories',()=>{
    for(const relativePath of ['3211.jpg','nested/3211.JPG','nested\\3211.jpg']){
      expect(isKnownAdvertisementImage(relativePath)).toBe(true);
      expect(isAdmissionAdvertisementCandidate({relativePath,kind:'image'})).toBe(true);
    }
    for(const filename of ['3211.png','3211.jpeg','3211 (1).jpg','03211.jpg','32110.jpg','3211.jpg.png'])expect(isKnownAdvertisementImage(filename)).toBe(false);
    expect(isAdmissionAdvertisementCandidate({relativePath:'3211.jpg',kind:'directory'})).toBe(false);
  });
  it('recognizes 101.1.jpg exactly without expanding to similar names or directories',()=>{
    for(const relativePath of ['101.1.jpg','nested/101.1.JPG','nested\\101.1.jpg']){
      expect(isKnownAdvertisementImage(relativePath)).toBe(true);
      expect(isAdmissionAdvertisementCandidate({relativePath,kind:'image'})).toBe(true);
    }
    for(const filename of ['101.1.png','101.1.jpeg','101.1 (1).jpg','0101.1.jpg','101.10.jpg','101.1.jpg.png'])expect(isKnownAdvertisementImage(filename)).toBe(false);
    expect(isAdmissionAdvertisementCandidate({relativePath:'101.1.jpg',kind:'directory'})).toBe(false);
  });
  it('matches exact basenames across creators and nested directories, including filename case',()=>{
    for(const filename of ['492.jpg','009-01.jpg','nested/492.JPG','nested\\009-01.JPG','扫码获取更多列表网红COS作品写真.png','nested/扫码获取更多列表网红cos作品写真.PNG','nested\\扫码获取更多列表网红COS作品写真.png'])expect(isKnownAdvertisementImage(filename)).toBe(true);
    for(const filename of ['1492.jpg','0492.jpg','492.jpeg','492.jpg.png','009-01 (1).jpg','other.jpg','扫码获取更多列表网红COS作品写真.jpg','扫码获取更多列表网红COS作品写真 (1).png','扫码获取更多列表网红COS作品写真.png.jpg'])expect(isKnownAdvertisementImage(filename)).toBe(false);
  });
  it('retains ordinary images and other attachments; paths never classify directories as ads',()=>{
    expect(isAdmissionAdvertisementCandidate({relativePath:'492.jpg',kind:'directory'})).toBe(false);
    expect(isAdmissionAdvertisementCandidate({relativePath:'492.jpg',kind:'image'})).toBe(true);
    expect(isAdmissionAdvertisementCandidate({relativePath:'ordinary.jpg',kind:'image'})).toBe(false);
    expect(isAdmissionAdvertisementCandidate({relativePath:'ad.url',kind:'other'})).toBe(true);
    expect(isAdmissionAdvertisementCandidate({relativePath:'notes.txt',kind:'other'})).toBe(true);
    expect(isAdmissionAdvertisementCandidate({relativePath:'keep.pdf',kind:'other'})).toBe(false);
  });
});
