// 公开固定测试 Key，执行同一个正式 C++ LocalSecret 实现；无协议导出私钥入口。
#include "device/sdk/local_secret.hpp"
#include <fstream>
#include <iostream>
using namespace vaultlink;
int rng(void *,unsigned char *out,size_t n){std::ifstream f("/dev/urandom",std::ios::binary);f.read(reinterpret_cast<char *>(out),n);return f?0:-1;}
int main(int argc,char **argv){try{
 require(argc==3,"invalid-test-input");Bytes private_key(32);private_key[31]=1;
 IdentityKey key(private_key,rng);wipe_bytes(private_key);
 if(std::string(argv[1])=="open-other-key"){private_key.assign(32,0);private_key[31]=2;key.unlock(private_key);wipe_bytes(private_key);}
 if(std::string(argv[1])=="open-locked")key.lock();
 auto request=decode(from_hex(argv[2]),32768);auto scope=request.at("scope").string();
 Value result=std::string(argv[1])=="seal"?key.seal_local(scope,request.at("plaintext").binary()):obj({{"plaintext",Value(key.open_local(scope,request.at("sealed")))}});
 auto raw=encode(result,32768);WipeBytes clean{raw};std::cout<<to_hex(raw)<<'\n';key.lock();return 0;
 }catch(const std::exception &e){std::cerr<<e.what()<<'\n';return 1;}}
